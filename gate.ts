#!/usr/bin/env bun

/**
 * opencode-free-gate — OpenCode 免费模型反代网关
 *
 * 从公共代理池自动获取 S 级代理，2 个 IP 轮换使用，失败自动切换
 * 兼容 OpenAI 和 Anthropic 格式
 *
 * 使用:
 *   bun run gate.ts
 *   PORT=8080 bun run gate.ts
 */

import https from 'node:https';
import { HttpsProxyAgent } from 'hpagent';
import { SocksProxyAgent } from 'socks-proxy-agent';

interface ProxyItem {
  address: string;
  protocol: string;
  latency: number;
  quality_grade: string;
}

interface Slot {
  addr: string;
  url: string;
  proto: 'http' | 'socks5';
}

const PROXY_API = 'https://proxy.amux.ai/api/proxies';
const UPSTREAM = 'https://opencode.ai/zen';
const PORT = parseInt(process.env.PORT || '13339');
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');
const TIMEOUT = 120000;
const STREAM_TIMEOUT = 300000;
const SLOT_COUNT = Math.max(3, Math.min(5, parseInt(process.env.SLOT_COUNT || '3')));
const PROXY_PROBE_TIMEOUT = parseInt(process.env.PROXY_PROBE_TIMEOUT || '8000');
const PROXY_REFRESH_MS = parseInt(process.env.PROXY_REFRESH_MS || '300000');

// –– 代理模式：auto | custom ––
const PROXY_MODE = (process.env.PROXY_MODE || 'auto').toLowerCase() as 'auto' | 'custom';

// –– 自定义代理配置（custom 模式必填，auto 模式可选兜底）––
const CUSTOM_PROXIES = process.env.CUSTOM_PROXIES || '';

// –– ZenProxy 备用通道 ––
const ZENPROXY_RELAY = process.env.ZENPROXY_RELAY || 'https://zenproxy.top/api/relay';
const ZENPROXY_KEY = process.env.ZENPROXY_KEY || '';
const FORCE_RELAY = process.env.FORCE_RELAY === '1';

// –– 全局状态 ––
let candidates: ProxyItem[] = [];
let slots: Slot[] = [];
let customSlots: Slot[] = [];
let rrCursor = 0;
let refreshing = false;

/** 转发到上游时保留的请求头 */
const FORWARD = [
  'authorization',
  'x-opencode-project',
  'x-opencode-session',
  'x-opencode-request',
  'x-opencode-client',
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
];

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  自定义代理解析
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function parseCustomProxies(input: string): ProxyItem[] {
  if (!input.trim()) return [];
  return input.split(',').map((addr) => {
    const trimmed = addr.trim();
    if (!trimmed) return null;
    const isSocks = trimmed.startsWith('socks5://') || trimmed.startsWith('socks5h://');
    return {
      address: trimmed.replace(/^https?:\/\//, '').replace(/^socks5h?:\/\//, ''),
      protocol: isSocks ? 'socks5' : 'http',
      latency: 0,
      quality_grade: 'custom',
    };
  }).filter((p): p is ProxyItem => p !== null);
}

async function initCustomSlots(): Promise<void> {
  if (!CUSTOM_PROXIES) return;
  const items = parseCustomProxies(CUSTOM_PROXIES);
  if (items.length === 0) return;

  const results = await Promise.all(items.map(async (item) => {
    const r = await probe(item);
    return { item, ...r };
  }));

  for (const r of results) {
    if (!r.ok) continue;
    const url = r.item.protocol === 'socks5' ? `socks5h://${r.item.address}` : `http://${r.item.address}`;
    customSlots.push({ addr: r.item.address, url, proto: r.item.protocol as 'http' | 'socks5' });
    console.log(`[兜底+] ${r.item.address} (${r.latencyMs}ms)`);
  }
  console.log(`[兜底] ${customSlots.length}/${items.length} custom proxies ready`);
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  候选池（S级免费代理，仅 auto 模式使用）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function loadCandidates(): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(PROXY_API, { signal: ctl.signal });
    const data = await res.json();
    const all: any[] = Array.isArray(data) ? data : [];
    candidates = all
      .filter((p) => p.quality_grade === 'S' && p.status === 'active')
      .sort((a, b) => a.latency - b.latency);
    console.log(`[选] ${candidates.length} S-grade candidates`);
  } catch (e: any) {
    candidates = [];
    console.warn(`[选] load failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function nextCandidate(used: Set<string>): ProxyItem | null {
  while (candidates.length > 0) {
    const item = candidates.shift()!;
    if (!used.has(item.address)) return item;
  }
  return null;
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  探活
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function makeAgent(proxyUrl: string, proto: 'http' | 'socks5'): https.Agent {
  if (proto === 'socks5') {
    return new SocksProxyAgent(proxyUrl, { timeout: 10000 }) as unknown as https.Agent;
  }
  return new HttpsProxyAgent({
    proxy: proxyUrl,
    keepAlive: false,
    timeout: 10000,
  }) as unknown as https.Agent;
}

async function probe(item: ProxyItem): Promise<{ ok: boolean; latencyMs?: number }> {
  const url = item.protocol === 'socks5' ? `socks5h://${item.address}` : `http://${item.address}`;
  const agent = makeAgent(url, item.protocol as 'http' | 'socks5');
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = https.request(
        `${UPSTREAM}/v1/models`,
        {
          method: 'GET',
          headers: { accept: 'application/json', authorization: 'Bearer public' },
          agent,
          rejectUnauthorized: false,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (timer) clearTimeout(timer);
            resolve({ status: res.statusCode || 0 });
          });
          res.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
        },
      );
      req.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
      timer = setTimeout(() => { req.destroy(new Error('probe-timeout')); reject(new Error('probe-timeout')); }, PROXY_PROBE_TIMEOUT);
      req.end();
    });
    return { ok: result.status >= 200 && result.status < 400, latencyMs: Date.now() - start };
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
    try { agent.destroy(); } catch {}
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  Slot 管理（仅 auto 模式使用）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function fillSlots(): Promise<void> {
  if (slots.length >= SLOT_COUNT) return;
  const used = new Set(slots.map((s) => s.addr));
  const needed = SLOT_COUNT - slots.length;

  const batch: ProxyItem[] = [];
  while (batch.length < needed + 3) {
    const c = nextCandidate(used);
    if (!c) {
      if (candidates.length === 0) await loadCandidates();
      const c2 = nextCandidate(used);
      if (!c2) break;
      batch.push(c2);
      used.add(c2.address);
      continue;
    }
    batch.push(c);
    used.add(c.address);
  }
  if (batch.length === 0) return;

  const results = await Promise.all(batch.map(async (item) => {
    const r = await probe(item);
    return { item, ...r };
  }));

  let added = 0;
  for (const r of results) {
    if (!r.ok || slots.length >= SLOT_COUNT) continue;
    const url = r.item.protocol === 'socks5' ? `socks5h://${r.item.address}` : `http://${r.item.address}`;
    slots.push({ addr: r.item.address, url, proto: r.item.protocol as 'http' | 'socks5' });
    console.log(`[探+] ${r.item.address} (${r.latencyMs}ms)`);
    added++;
  }
  console.log(`[槽] ${slots.length}/${SLOT_COUNT} ready (added ${added})`);
}

function dropSlot(addr: string): void {
  const idx = slots.findIndex((s) => s.addr === addr);
  if (idx >= 0) {
    slots.splice(idx, 1);
    console.log(`[弃] ${addr} → ${slots.length}/${SLOT_COUNT}`);
  }
  if (PROXY_MODE === 'auto') {
    fillSlots().catch((e) => console.error('[槽] fill error:', e.message));
  }
}

function dropCustomSlot(addr: string): void {
  const idx = customSlots.findIndex((s) => s.addr === addr);
  if (idx >= 0) {
    customSlots.splice(idx, 1);
    console.log(`[弃兜底] ${addr} → ${customSlots.length} remaining`);
  }
}

async function refreshSlots(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    await loadCandidates();
    await fillSlots();
  } catch (e: any) {
    console.error('[刷新] error:', e.message);
  } finally {
    refreshing = false;
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  请求处理
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function collectHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = {};
  for (const k of FORWARD) {
    if (k === 'authorization') continue;
    const v = req.headers.get(k);
    if (v) h[k] = v;
  }
  h['authorization'] = 'Bearer public';
  if (!h['x-opencode-client']) h['x-opencode-client'] = 'cli';
  if (!h['content-type']) h['content-type'] = 'application/json';
  return h;
}

function doHttps(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, agent: https.Agent,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${UPSTREAM}${path}`,
      { method, headers, agent, timeout: TIMEOUT, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 200, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('超时')));
    if (body) req.write(body);
    req.end();
  });
}

function doHttpsStream(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, agent: https.Agent,
): Promise<{ status: number; stream: ReadableStream<Uint8Array> }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${UPSTREAM}${path}`,
      { method, headers, agent, timeout: STREAM_TIMEOUT, rejectUnauthorized: false },
      (res) => {
        res.on('end', () => { try { agent.destroy(); } catch {} });
        res.on('error', () => { try { agent.destroy(); } catch {} });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on('end', () => controller.close());
            res.on('error', (err) => controller.error(err));
          },
          cancel() { res.destroy(); },
        });
        resolve({ status: res.statusCode || 200, stream });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  dispatch（auto 模式）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

/** auto 模式：S级代理 → ZenProxy → 自定义代理 */
async function dispatchAuto(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, triedAddrs = new Set<string>(),
): Promise<Response> {
  if (FORCE_RELAY) {
    if (ZENPROXY_KEY) return proxyViaRelay(path, method, headers, body);
    return new Response('{"error":"FORCE_RELAY 但未配置 ZENPROXY_KEY"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  if (slots.length === 0) await fillSlots();

  const available = slots.filter((s) => !triedAddrs.has(s.addr));
  const slot = available[rrCursor % available.length] || available[0] || null;
  rrCursor++;

  if (!slot) {
    if (ZENPROXY_KEY) {
      console.log(`[回退] S级代理失败 → ZenProxy relay`);
      return proxyViaRelay(path, method, headers, body);
    }
    if (customSlots.length > 0) {
      console.log(`[回退] S级代理失败 → 自定义代理兜底`);
      return dispatchViaCustom(path, method, headers, body);
    }
    return new Response('{"error":"没有可用代理"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  triedAddrs.add(slot.addr);
  console.log(`[取] ${slot.addr} (retry=${retry})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(slot.url, slot.proto);

  try {
    if (isStream) {
      const { status: s, stream } = await doHttpsStream(path, method, headers, body, agent);
      if (s >= 400) {
        try { agent.destroy(); } catch {}
        if (s === 429) console.log(`[429] ${slot.addr} 被限流，换IP重试(流式)`);
        else console.log(`[错码] ${slot.addr} 状态码 ${s}，换IP重试(流式)`);
        dropSlot(slot.addr);
        if (retry < MAX_RETRIES) {
          return dispatchAuto(path, method, headers, body, retry + 1, triedAddrs);
        }
        if (ZENPROXY_KEY) {
          console.log(`[回退] 重试耗尽 → ZenProxy relay`);
          return proxyViaRelay(path, method, headers, body);
        }
        if (customSlots.length > 0) {
          console.log(`[回退] 重试耗尽 → 自定义代理兜底`);
          return dispatchViaCustom(path, method, headers, body);
        }
        return new Response(JSON.stringify({ error: `所有代理失败: 状态码 ${s}` }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try { agent.destroy(); } catch {}

    if (status >= 400) {
      if (status === 429) console.log(`[429] ${slot.addr} 被限流，换IP重试`);
      else console.log(`[错码] ${slot.addr} 状态码 ${status}，换IP重试`);
      dropSlot(slot.addr);
      if (retry < MAX_RETRIES) {
        return dispatchAuto(path, method, headers, body, retry + 1, triedAddrs);
      }
      if (ZENPROXY_KEY) {
        console.log(`[回退] 重试耗尽 → ZenProxy relay`);
        return proxyViaRelay(path, method, headers, body);
      }
      if (customSlots.length > 0) {
        console.log(`[回退] 重试耗尽 → 自定义代理兜底`);
        return dispatchViaCustom(path, method, headers, body);
      }
      return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } catch (e: any) {
    console.error(`[错] ${slot.addr}: ${e.message}`);
    try { agent.destroy(); } catch {}

    dropSlot(slot.addr);

    if (retry < MAX_RETRIES) {
      return dispatchAuto(path, method, headers, body, retry + 1, triedAddrs);
    }
    if (ZENPROXY_KEY) {
      console.log(`[回退] 重试耗尽 → ZenProxy relay`);
      return proxyViaRelay(path, method, headers, body);
    }
    if (customSlots.length > 0) {
      console.log(`[回退] 重试耗尽 → 自定义代理兜底`);
      return dispatchViaCustom(path, method, headers, body);
    }
    return new Response(JSON.stringify({ error: `所有代理失败: ${e.message}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  dispatch（custom 模式）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

/** custom 模式：仅使用自定义代理 → ZenProxy（自定义代理不标记失败，失败后重试同一个） */
async function dispatchCustom(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0,
): Promise<Response> {
  if (FORCE_RELAY) {
    if (ZENPROXY_KEY) return proxyViaRelay(path, method, headers, body);
    return new Response('{"error":"FORCE_RELAY 但未配置 ZENPROXY_KEY"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  if (customSlots.length === 0) {
    if (ZENPROXY_KEY) {
      console.log(`[回退] 无自定义代理 → ZenProxy relay`);
      return proxyViaRelay(path, method, headers, body);
    }
    return new Response('{"error":"没有可用代理"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  // 轮询选择代理，但不标记失败
  const slot = customSlots[rrCursor % customSlots.length];
  rrCursor = (rrCursor + 1) % customSlots.length;

  console.log(`[取] ${slot.addr} (retry=${retry})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(slot.url, slot.proto);

  try {
    if (isStream) {
      const { status: s, stream } = await doHttpsStream(path, method, headers, body, agent);
      if (s >= 400) {
        try { agent.destroy(); } catch {}
        if (s === 429) console.log(`[429] ${slot.addr} 被限流，重试(流式)`);
        else console.log(`[错码] ${slot.addr} 状态码 ${s}，重试(流式)`);
        if (retry < MAX_RETRIES) {
          return dispatchCustom(path, method, headers, body, retry + 1);
        }
        if (ZENPROXY_KEY) {
          console.log(`[回退] 重试耗尽 → ZenProxy relay`);
          return proxyViaRelay(path, method, headers, body);
        }
        return new Response(JSON.stringify({ error: `代理失败: 状态码 ${s}` }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try { agent.destroy(); } catch {}

    if (status >= 400) {
      if (status === 429) console.log(`[429] ${slot.addr} 被限流，重试`);
      else console.log(`[错码] ${slot.addr} 状态码 ${status}，重试`);
      if (retry < MAX_RETRIES) {
        return dispatchCustom(path, method, headers, body, retry + 1);
      }
      if (ZENPROXY_KEY) {
        console.log(`[回退] 重试耗尽 → ZenProxy relay`);
        return proxyViaRelay(path, method, headers, body);
      }
      return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } catch (e: any) {
    console.error(`[错] ${slot.addr}: ${e.message}`);
    try { agent.destroy(); } catch {}

    if (retry < MAX_RETRIES) {
      return dispatchCustom(path, method, headers, body, retry + 1);
    }
    if (ZENPROXY_KEY) {
      console.log(`[回退] 重试耗尽 → ZenProxy relay`);
      return proxyViaRelay(path, method, headers, body);
    }
    return new Response(JSON.stringify({ error: `代理失败: ${e.message}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  通用调度入口
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function dispatch(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, triedAddrs = new Set<string>(),
): Promise<Response> {
  if (PROXY_MODE === 'custom') {
    return dispatchCustom(path, method, headers, body, retry);
  }
  return dispatchAuto(path, method, headers, body, retry, triedAddrs);
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  通过自定义代理转发（auto 模式兜底）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function dispatchViaCustom(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, triedAddrs = new Set<string>(),
): Promise<Response> {
  if (customSlots.length === 0) {
    return new Response('{"error":"没有可用的自定义代理"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  const available = customSlots.filter((s) => !triedAddrs.has(s.addr));
  if (available.length === 0) {
    return new Response('{"error":"所有自定义代理均失败"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  const slot = available[0];
  triedAddrs.add(slot.addr);
  console.log(`[兜底取] ${slot.addr} (retry=${retry})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(slot.url, slot.proto);

  try {
    if (isStream) {
      const { stream } = await doHttpsStream(path, method, headers, body, agent);
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try { agent.destroy(); } catch {}

    return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } catch (e: any) {
    console.error(`[兜底错] ${slot.addr}: ${e.message}`);
    try { agent.destroy(); } catch {}

    if (retry < MAX_RETRIES) {
      return dispatchViaCustom(path, method, headers, body, retry + 1, triedAddrs);
    }
    return new Response(JSON.stringify({ error: `所有自定义代理失败: ${e.message}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  ZenProxy
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function proxyViaRelay(
  path: string, method: string, headers: Record<string, string>, body: string | undefined,
): Promise<Response> {
  const clean: Record<string, string> = { ...headers };
  delete clean['host'];
  delete clean['content-length'];
  delete clean['authorization'];

  const target = `${UPSTREAM}${path}`;
  const url = `${ZENPROXY_RELAY}?api_key=${encodeURIComponent(ZENPROXY_KEY)}&url=${encodeURIComponent(target)}&method=${method}`;

  const res = await fetch(url, { method: 'POST', headers: clean, body });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  路由
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function normalize(raw: string): string | null {
  const m = raw.match(/^\/(openai|anthropic)(\/v1\/.+)$/);
  return m ? m[2] : null;
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  服务
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

console.log(`[门] http://localhost:${PORT}`);
console.log(`[门] OpenAI:    /openai/v1/chat/completions | /openai/v1/models`);
console.log(`[门] Anthropic: /anthropic/v1/messages`);
console.log(`[门] 模式:      ${PROXY_MODE}`);
if (PROXY_MODE === 'auto') {
  console.log(`[门] 策略:      S级代理(${SLOT_COUNT}槽) → ${ZENPROXY_KEY ? 'ZenProxy → ' : ''}自定义代理兜底${CUSTOM_PROXIES ? ` (${parseCustomProxies(CUSTOM_PROXIES).length}个)` : '(未配置)'}`);
} else {
  console.log(`[门] 策略:      自定义代理 → ${ZENPROXY_KEY ? 'ZenProxy → ' : ''}直连`);
}
console.log(`[门] 备用:      ${ZENPROXY_KEY ? `ZenProxy relay 已启用 (${ZENPROXY_RELAY})` : '未配置 ZENPROXY_KEY'}`);
console.log(`[门] 重试:      MAX_RETRIES=${MAX_RETRIES}`);

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const { pathname: raw, search } = new URL(req.url);
    const method = req.method;
    const pathname = normalize(raw);
    console.log(`[>] ${method} ${raw}`);

    if (!pathname) {
      if (raw === '/' || raw === '/v1') {
        return new Response(
          JSON.stringify({ status: 'ok', mode: PROXY_MODE, slots: slots.map((s) => s.addr), customSlots: customSlots.map((s) => s.addr) }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    }

    if (pathname === '/v1/models' && method === 'GET') {
      return dispatch(pathname + search, 'GET', collectHeaders(req));
    }

    if ((pathname === '/v1/chat/completions' || pathname === '/v1/messages') && method === 'POST') {
      let body = await req.text();
      const h = collectHeaders(req);
      const isStream =
        h['accept']?.includes('event-stream') ||
        (() => { try { return JSON.parse(body).stream; } catch { return false; } })();
      if (isStream) {
        h['accept'] = 'text/event-stream';
        try {
          const json = JSON.parse(body);
          if (!json.stream) { json.stream = true; body = JSON.stringify(json); }
        } catch {}
      }
      return dispatch(pathname, 'POST', h, body);
    }

    return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  },
});

// 启动：初始化
const initPromise = PROXY_MODE === 'auto'
  ? loadCandidates().then(() => fillSlots()).then(() => initCustomSlots())
  : initCustomSlots();

initPromise
  .catch((e) => console.error('[门] initial fill failed:', e));

// 定期刷新（仅 auto 模式）
const refreshTimer = PROXY_MODE === 'auto'
  ? setInterval(() => {
      refreshSlots().catch((e) => console.error('[门] refresh failed:', e));
    }, PROXY_REFRESH_MS)
  : null;

// 优雅退出
process.on('SIGTERM', () => { if (refreshTimer) clearInterval(refreshTimer); process.exit(0); });
process.on('SIGINT', () => { if (refreshTimer) clearInterval(refreshTimer); process.exit(0); });
