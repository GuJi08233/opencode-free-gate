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

interface RequestLog {
  path: string;
  method: string;
  startTime: number;
  retryCount: number;
  proxiesTried: Set<string>;
  finalProxy: string | null;
  finalStatus: number | null;
}

const PROXY_API = 'https://proxy.amux.ai/api/proxies';
const UPSTREAM = 'https://opencode.ai/zen';
const PORT = parseInt(process.env.PORT || '13339');
const TIMEOUT = 120000;
const STREAM_TIMEOUT = 300000;
const PROXY_FIRST_BYTE_TIMEOUT = 6000;  // 单次代理首字节超时（6s）
const SLOT_COUNT = Math.max(3, Math.min(5, parseInt(process.env.SLOT_COUNT || '3')));
const PROXY_PROBE_TIMEOUT = parseInt(process.env.PROXY_PROBE_TIMEOUT || '8000');
const PROXY_REFRESH_MS = parseInt(process.env.PROXY_REFRESH_MS || '300000');

// –– 代理模式：auto | custom ––
const PROXY_MODE = (process.env.PROXY_MODE || 'auto').toLowerCase() as 'auto' | 'custom';

// –– 各层级重试次数配置 ––
const SLOT_RETRIES = parseInt(process.env.SLOT_RETRIES || String(SLOT_COUNT));  // S级代理重试次数（默认=槽位数）
const CUSTOM_RETRIES = parseInt(process.env.CUSTOM_RETRIES || '0');  // 自定义代理重试次数（0=按代理数量轮询）
const ZENPROXY_RETRIES = parseInt(process.env.ZENPROXY_RETRIES || '1');  // ZenProxy重试次数

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
        clearTimeout(firstByteTimer);
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 200, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      },
    );
    const firstByteTimer = setTimeout(() => req.destroy(new Error('代理超时')), PROXY_FIRST_BYTE_TIMEOUT);
    req.on('error', (e) => { clearTimeout(firstByteTimer); reject(e); });
    req.on('timeout', () => { clearTimeout(firstByteTimer); req.destroy(new Error('超时')); });
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
        clearTimeout(firstByteTimer);
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
    const firstByteTimer = setTimeout(() => req.destroy(new Error('代理超时')), PROXY_FIRST_BYTE_TIMEOUT);
    req.on('error', (e) => { clearTimeout(firstByteTimer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  dispatch（auto 模式）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

/** auto 模式：S级代理(SLOT_RETRIES) → ZenProxy(ZENPROXY_RETRIES) → 自定义代理(CUSTOM_RETRIES) */
async function dispatchAuto(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, triedAddrs = new Set<string>(), reqLog?: RequestLog,
): Promise<Response> {
  if (FORCE_RELAY) {
    if (ZENPROXY_KEY) return dispatchZenProxy(path, method, headers, body);
    return new Response('{"error":"FORCE_RELAY 但未配置 ZENPROXY_KEY"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  if (slots.length === 0) await fillSlots();

  const available = slots.filter((s) => !triedAddrs.has(s.addr));
  const slot = available[rrCursor % available.length] || available[0] || null;
  rrCursor++;

  if (!slot || retry >= SLOT_RETRIES) {
    // S级代理耗尽 → ZenProxy → 自定义代理（三层串联）
    let lastResult: Response | null = null;
    if (ZENPROXY_KEY) {
      console.log(`[回退] S级代理(${retry}/${SLOT_RETRIES}) → ZenProxy`);
      lastResult = await dispatchZenProxy(path, method, headers, body, 0, reqLog);
      if (lastResult.status < 400) return lastResult;
      console.log(`[回退] ZenProxy(${lastResult.status}) → 自定义代理`);
    }
    if (customSlots.length > 0) {
      return dispatchViaCustom(path, method, headers, body, 0, reqLog);
    }
    if (lastResult) return lastResult;
    return new Response('{"error":"没有可用代理"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  triedAddrs.add(slot.addr);
  if (reqLog) {
    reqLog.proxiesTried.add(slot.addr);
    reqLog.retryCount = retry;
  }
  console.log(`[S级] ${slot.addr} (${retry + 1}/${SLOT_RETRIES})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(slot.url, slot.proto);

  try {
    if (isStream) {
      const { status: s, stream } = await doHttpsStream(path, method, headers, body, agent);
      if (s >= 400) {
        try { agent.destroy(); } catch {}
        if (s === 429) console.log(`[429] ${slot.addr} 被限流`);
        else console.log(`[错码] ${slot.addr} 状态码 ${s}`);
        dropSlot(slot.addr);
        return dispatchAuto(path, method, headers, body, retry + 1, triedAddrs, reqLog);
      }
      if (reqLog) {
        reqLog.finalProxy = slot.addr;
        reqLog.finalStatus = s;
      }
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try { agent.destroy(); } catch {}

    if (status >= 400) {
      if (status === 429) console.log(`[429] ${slot.addr} 被限流`);
      else console.log(`[错码] ${slot.addr} 状态码 ${status}`);
      dropSlot(slot.addr);
      return dispatchAuto(path, method, headers, body, retry + 1, triedAddrs, reqLog);
    }

    if (reqLog) {
      reqLog.finalProxy = slot.addr;
      reqLog.finalStatus = status;
    }
    return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } catch (e: any) {
    console.error(`[错] ${slot.addr}: ${e.message}`);
    try { agent.destroy(); } catch {}
    dropSlot(slot.addr);
    return dispatchAuto(path, method, headers, body, retry + 1, triedAddrs, reqLog);
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  dispatch（custom 模式）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

/** custom 模式：仅使用自定义代理 → ZenProxy → 直连（自定义代理不标记失败，按序轮询） */
async function dispatchCustom(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, reqLog?: RequestLog,
): Promise<Response> {
  if (FORCE_RELAY) {
    if (ZENPROXY_KEY) return dispatchZenProxy(path, method, headers, body);
    return new Response('{"error":"FORCE_RELAY 但未配置 ZENPROXY_KEY"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  const maxRetries = CUSTOM_RETRIES > 0 ? CUSTOM_RETRIES : customSlots.length;

  if (customSlots.length === 0 || retry >= maxRetries) {
    if (ZENPROXY_KEY) {
      console.log(`[回退] 自定义代理(${retry}/${maxRetries}) → ZenProxy`);
      return dispatchZenProxy(path, method, headers, body, 0, reqLog);
    }
    return new Response('{"error":"没有可用代理"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  const slot = customSlots[rrCursor % customSlots.length];
  rrCursor = (rrCursor + 1) % customSlots.length;

  if (reqLog) {
    reqLog.proxiesTried.add(slot.addr);
    reqLog.retryCount = retry;
  }
  console.log(`[自定义] ${slot.addr} (${retry + 1}/${maxRetries})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(slot.url, slot.proto);

  try {
    if (isStream) {
      const { status: s, stream } = await doHttpsStream(path, method, headers, body, agent);
      if (s >= 400) {
        try { agent.destroy(); } catch {}
        if (s === 429) console.log(`[429] ${slot.addr} 被限流`);
        else console.log(`[错码] ${slot.addr} 状态码 ${s}`);
        return dispatchCustom(path, method, headers, body, retry + 1, reqLog);
      }
      if (reqLog) {
        reqLog.finalProxy = slot.addr;
        reqLog.finalStatus = s;
      }
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try { agent.destroy(); } catch {}

    if (status >= 400) {
      if (status === 429) console.log(`[429] ${slot.addr} 被限流`);
      else console.log(`[错码] ${slot.addr} 状态码 ${status}`);
      return dispatchCustom(path, method, headers, body, retry + 1, reqLog);
    }

    if (reqLog) {
      reqLog.finalProxy = slot.addr;
      reqLog.finalStatus = status;
    }
    return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } catch (e: any) {
    console.error(`[错] ${slot.addr}: ${e.message}`);
    try { agent.destroy(); } catch {}
    return dispatchCustom(path, method, headers, body, retry + 1, reqLog);
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  通用调度入口
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function dispatch(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, triedAddrs = new Set<string>(), reqLog?: RequestLog,
): Promise<Response> {
  if (PROXY_MODE === 'custom') {
    return dispatchCustom(path, method, headers, body, retry, reqLog);
  }
  return dispatchAuto(path, method, headers, body, retry, triedAddrs, reqLog);
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  通过自定义代理转发（auto 模式兜底）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

/** auto模式兜底：自定义代理按序轮询，不拉黑 */
async function dispatchViaCustom(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, reqLog?: RequestLog,
): Promise<Response> {
  const maxRetries = CUSTOM_RETRIES > 0 ? CUSTOM_RETRIES : customSlots.length;

  if (customSlots.length === 0 || retry >= maxRetries) {
    return new Response('{"error":"没有可用代理"}', { status: 502, headers: { 'content-type': 'application/json' } });
  }

  const slot = customSlots[rrCursor % customSlots.length];
  rrCursor = (rrCursor + 1) % customSlots.length;

  if (reqLog) {
    reqLog.proxiesTried.add(slot.addr);
    reqLog.retryCount = retry;
  }
  console.log(`[自定义] ${slot.addr} (${retry + 1}/${maxRetries})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(slot.url, slot.proto);

  try {
    if (isStream) {
      const { status: s, stream } = await doHttpsStream(path, method, headers, body, agent);
      if (s >= 400) {
        try { agent.destroy(); } catch {}
        if (s === 429) console.log(`[429] ${slot.addr} 被限流`);
        else console.log(`[错码] ${slot.addr} 状态码 ${s}`);
        return dispatchViaCustom(path, method, headers, body, retry + 1, reqLog);
      }
      if (reqLog) {
        reqLog.finalProxy = slot.addr;
        reqLog.finalStatus = s;
      }
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try { agent.destroy(); } catch {}

    if (status >= 400) {
      if (status === 429) console.log(`[429] ${slot.addr} 被限流`);
      else console.log(`[错码] ${slot.addr} 状态码 ${status}`);
      return dispatchViaCustom(path, method, headers, body, retry + 1, reqLog);
    }

    if (reqLog) {
      reqLog.finalProxy = slot.addr;
      reqLog.finalStatus = status;
    }
    return new Response(respBody, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } catch (e: any) {
    console.error(`[错] ${slot.addr}: ${e.message}`);
    try { agent.destroy(); } catch {}
    return dispatchViaCustom(path, method, headers, body, retry + 1, reqLog);
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  ZenProxy（带重试）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

/** ZenProxy 重试 ZENPROXY_RETRIES 次 */
async function dispatchZenProxy(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, retry = 0, reqLog?: RequestLog,
): Promise<Response> {
  console.log(`[ZenProxy] (${retry + 1}/${ZENPROXY_RETRIES})`);
  if (reqLog) {
    reqLog.proxiesTried.add('ZenProxy');
    reqLog.retryCount = retry;
  }

  try {
    const result = await proxyViaRelay(path, method, headers, body);
    if (result.status >= 400 && retry + 1 < ZENPROXY_RETRIES) {
      console.log(`[ZenProxy] 状态码 ${result.status}，重试`);
      return dispatchZenProxy(path, method, headers, body, retry + 1, reqLog);
    }
    if (reqLog) {
      reqLog.finalProxy = 'ZenProxy';
      reqLog.finalStatus = result.status;
    }
    return result;
  } catch (e: any) {
    console.error(`[ZenProxy] 错误: ${e.message}`);
    if (retry + 1 < ZENPROXY_RETRIES) {
      return dispatchZenProxy(path, method, headers, body, retry + 1, reqLog);
    }
    return new Response(JSON.stringify({ error: `ZenProxy失败: ${e.message}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

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
//  模型过滤与重定向（实时获取，60秒缓存）
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

// 额外直接放行的模型（不做重命名）
const EXTRA_MODELS = ['big-pickle'];

// 缓存
let modelCache: { rename: Record<string, string>; redirect: Record<string, string>; ts: number } | null = null;
const MODEL_CACHE_TTL = 60000;  // 60秒缓存

/** 从上游实时获取免费模型列表，构建映射 */
async function fetchModelMaps(): Promise<{ rename: Record<string, string>; redirect: Record<string, string> }> {
  // 缓存未过期直接返回
  if (modelCache && Date.now() - modelCache.ts < MODEL_CACHE_TTL) {
    return modelCache;
  }

  try {
    const res = await fetch(`${UPSTREAM}/v1/models`, {
      headers: { accept: 'application/json', authorization: 'Bearer public' },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const all: any[] = Array.isArray(data) ? data : data.data || [];

    const rename: Record<string, string> = {};
    for (const m of all) {
      const id: string = m.id || m;
      if (id.endsWith('-free')) {
        // deepseek-v4-flash-free → deepseek-v4-flash
        rename[id] = id.replace(/-free$/, '');
      }
    }

    const redirect: Record<string, string> = {};
    for (const [upstream, display] of Object.entries(rename)) {
      redirect[display] = upstream;
    }

    modelCache = { rename, redirect, ts: Date.now() };
    console.log(`[模型] 已刷新 ${Object.keys(rename).length} 个免费模型`);
    return modelCache;
  } catch (e: any) {
    // 获取失败，返回缓存（如有）或空
    if (modelCache) {
      console.warn(`[模型] 刷新失败，使用缓存: ${e.message}`);
      return modelCache;
    }
    console.warn(`[模型] 刷新失败且无缓存: ${e.message}`);
    return { rename: {}, redirect: {} };
  }
}

/** 拦截 GET /v1/models，返回过滤+重命名后的模型列表 */
async function handleModelsList(): Promise<Response> {
  const { rename } = await fetchModelMaps();
  const models = Object.values(rename).concat(EXTRA_MODELS).sort().map((id) => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'opencode',
  }));
  return new Response(JSON.stringify({ object: 'list', data: models }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 将请求体中的模型名重定向为上游实际模型名 */
async function rewriteModel(body: string): Promise<string> {
  try {
    const { redirect } = await fetchModelMaps();
    const json = JSON.parse(body);
    if (json.model && redirect[json.model]) {
      const original = json.model;
      json.model = redirect[original];
      console.log(`[模型重定向] ${original} → ${json.model}`);
      return JSON.stringify(json);
    }
  } catch {}
  return body;
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  路由
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function normalize(raw: string): string | null {
  const m = raw.match(/^\/(openai|anthropic|codex)(\/v1\/.+)$/);
  return m ? m[2] : null;
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  服务
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

console.log(`[门] http://localhost:${PORT}`);
console.log(`[门] OpenAI:    /openai/v1/chat/completions | /openai/v1/models`);
console.log(`[门] Anthropic: /anthropic/v1/messages`);
console.log(`[门] Codex:     /codex/v1/responses`);
console.log(`[门] 模式:      ${PROXY_MODE}`);
console.log(`[门] 模型:      实时获取（60秒缓存）+ big-pickle`);
if (PROXY_MODE === 'auto') {
  console.log(`[门] 策略:      S级代理(${SLOT_COUNT}槽,重试${SLOT_RETRIES}次) → ${ZENPROXY_KEY ? `ZenProxy(${ZENPROXY_RETRIES}次) → ` : ''}自定义代理${CUSTOM_PROXIES ? `(${parseCustomProxies(CUSTOM_PROXIES).length}个,重试${CUSTOM_RETRIES || '按数量'}次)` : '(未配置)'}`);
} else {
  console.log(`[门] 策略:      自定义代理(${CUSTOM_RETRIES || '按数量'}次) → ${ZENPROXY_KEY ? `ZenProxy(${ZENPROXY_RETRIES}次) → ` : ''}直连`);
}
console.log(`[门] 备用:      ${ZENPROXY_KEY ? `ZenProxy relay 已启用 (${ZENPROXY_RELAY})` : '未配置 ZENPROXY_KEY'}`);

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const { pathname: raw, search } = new URL(req.url);
    const method = req.method;
    const pathname = normalize(raw);
    console.log(`[>] ${method} ${raw}`);

    // 创建请求日志
    const reqLog: RequestLog = {
      path: raw,
      method,
      startTime: Date.now(),
      retryCount: 0,
      proxiesTried: new Set<string>(),
      finalProxy: null,
      finalStatus: null,
    };

    if (!pathname) {
      if (raw === '/' || raw === '/v1') {
        return new Response(
          JSON.stringify({ status: 'ok', mode: PROXY_MODE, slots: slots.map((s) => s.addr), customSlots: customSlots.map((s) => s.addr) }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    }

    let response: Response;
    if (pathname === '/v1/models' && method === 'GET') {
      // 本地返回过滤+重命名后的模型列表，实时获取上游
      response = await handleModelsList();
    } else if ((pathname === '/v1/chat/completions' || pathname === '/v1/messages' || pathname === '/v1/responses') && method === 'POST') {
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
      // 模型名重定向（deepseek-v4-flash → deepseek-v4-flash-free）
      body = await rewriteModel(body);
      response = await dispatch(pathname, 'POST', h, body, 0, new Set<string>(), reqLog);
    } else {
      return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    }

    // 记录请求完成日志
    const elapsed = Date.now() - reqLog.startTime;
    const status = reqLog.finalStatus || response.status;
    const proxyCount = reqLog.proxiesTried.size;
    const finalProxy = reqLog.finalProxy || 'unknown';
    const resultStr = status >= 200 && status < 400 ? '完成' : '失败';
    console.log(`[${resultStr}] ${method} ${raw} | 状态:${status} | 重试:${reqLog.retryCount} | 代理IP:${proxyCount} | 耗时:${elapsed}ms | 代理:${finalProxy}`);

    return response;
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
