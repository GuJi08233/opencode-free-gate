#!/usr/bin/env bun

/**
 * opencode-free-gate — 多出口 IP 并发轮询的反代网关
 *
 * 维持 POOL_SIZE 个活跃出口 IP 轮询使用，失败自动替换
 * 候选池每 5 分钟刷新一次，新代理先探活再入池
 * 兼容 OpenAI 和 Anthropic 格式
 *
 * 使用:
 *   bun run gate.ts
 *   PORT=8080 POOL_SIZE=20 bun run gate.ts
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

interface ActiveProxy {
  addr: string;
  url: string;
  proto: 'http' | 'socks5';
  state: 'active' | 'replacing';
  busy: number;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastUsedAt: number;
  avgLatencyMs: number;
}

const PROXY_API = 'https://proxy.amux.ai/api/proxies';
const UPSTREAM = 'https://opencode.ai/zen';
const PORT = parseInt(process.env.PORT || '13339');
const MAX_RETRIES = 3;
const TIMEOUT = 120000;
const STREAM_TIMEOUT = 300000;

// –– 池配置 ––
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '10');
const MAX_CONCURRENT_PER_PROXY = parseInt(process.env.MAX_CONCURRENT_PER_PROXY || '3');
const PROXY_FAILURE_THRESHOLD = parseInt(process.env.PROXY_FAILURE_THRESHOLD || '3');
const PROXY_PROBE_TIMEOUT = parseInt(process.env.PROXY_PROBE_TIMEOUT || '8000');
const PROXY_PROBE_PATH = process.env.PROXY_PROBE_PATH || '/v1/models';
const PROXY_REFRESH_MS = parseInt(process.env.PROXY_REFRESH_MS || '300000');
const BLACKLIST_TTL = parseInt(process.env.BLACKLIST_TTL || '600000'); // 黑名单 10 分钟过期
const SOFT_OVERFLOW_MAX = parseInt(process.env.SOFT_OVERFLOW_MAX || '6'); // 单代理软溢出上限
const PROBE_CONCURRENCY = parseInt(process.env.PROBE_CONCURRENCY || '5'); // 并行探活数
const POOL_LOW_THRESHOLD = parseInt(process.env.POOL_LOW_THRESHOLD || '3'); // 池子低于此值触发补位

// –– ZenProxy 备用通道：池子全挂时回退到 /api/relay 转发
//    部署示例: ZENPROXY_KEY=xxxx bun run gate.ts
const ZENPROXY_RELAY = process.env.ZENPROXY_RELAY || 'https://zenproxy.top/api/relay';
const ZENPROXY_KEY = process.env.ZENPROXY_KEY || '';
const FORCE_RELAY = process.env.FORCE_RELAY === '1';   // 调试用：跳过代理池直接走 relay

// –– 全局状态 ––
let candidates: ProxyItem[] = [];
const blacklist = new Map<string, number>(); // addr → expiresAt
let active: ActiveProxy[] = [];
let rrCursor = 0;
let refillInProgress = false;

function isBlacklisted(addr: string): boolean {
  const exp = blacklist.get(addr);
  if (!exp) return false;
  if (Date.now() > exp) { blacklist.delete(addr); return false; }
  return true;
}
function blacklistAdd(addr: string): void {
  blacklist.set(addr, Date.now() + BLACKLIST_TTL);
}
function blacklistCleanup(): void {
  const now = Date.now();
  for (const [k, exp] of blacklist) { if (now > exp) blacklist.delete(k); }
}

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
//  候选池
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function loadCandidates(): Promise<void> {
  // 5s 拿不到候选就放弃（避免本机不可达时挂死）
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(PROXY_API, { signal: ctl.signal });
    const all: any[] = await res.json();
    candidates = all
      .filter((p) => p.quality_grade === 'S' && p.status === 'active')
      .sort((a, b) => a.latency - b.latency);
    blacklistCleanup(); // 只清除过期条目，保留近期拉黑的
    console.log(`[选] candidates loaded: ${candidates.length} S-grade`);
  } catch (e: any) {
    candidates = [];   // 拉不到就清空，让上层走 ZenProxy fallback
    console.warn(`[选] load failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 从候选池取一个（O(1) shift + 跳过黑名单） */
function nextCandidate(): { item: ProxyItem; url: string; proto: 'http' | 'socks5' } | null {
  while (candidates.length > 0) {
    const item = candidates.shift()!; // shift 取延迟最低的（数组已升序排列）
    if (isBlacklisted(item.address)) continue;
    const url = item.protocol === 'socks5' ? `socks5h://${item.address}` : `http://${item.address}`;
    return { item, url, proto: item.protocol as 'http' | 'socks5' };
  }
  return null;
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  预热探活
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

async function probe(
  addr: string,
  url: string,
  proto: 'http' | 'socks5',
): Promise<{ ok: boolean; latencyMs?: number; reason?: string }> {
  const agent = makeAgent(url, proto);
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request(
        `${UPSTREAM}${PROXY_PROBE_PATH}`,
        {
          method: 'GET',
          headers: { accept: 'application/json', authorization: 'Bearer public' },
          agent,
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            if (timer) clearTimeout(timer);
            resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') });
          });
          res.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
        },
      );
      req.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
      timer = setTimeout(() => { req.destroy(new Error('probe-timeout')); reject(new Error('probe-timeout')); }, PROXY_PROBE_TIMEOUT);
      req.end();
    });
    if (result.status >= 200 && result.status < 400) {
      return { ok: true, latencyMs: Date.now() - start };
    }
    return { ok: false, reason: `status ${result.status}` };
  } catch (e: any) {
    return { ok: false, reason: e.message };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      agent.destroy();
    } catch {}
  }
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  活跃池：探活→入池→轮询→退役→补位
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

async function fillActive(): Promise<void> {
  const needed = POOL_SIZE - active.length;
  if (needed <= 0) return;

  // 多取一些候选，探活失败的会被淘汰
  const batch: Array<{ item: ProxyItem; url: string; proto: 'http' | 'socks5' }> = [];
  while (batch.length < needed + PROBE_CONCURRENCY) {
    let cand = nextCandidate();
    if (!cand) {
      await loadCandidates();
      cand = nextCandidate();
      if (!cand) break;
    }
    batch.push(cand);
  }
  if (batch.length === 0) return;

  // 并行探活（分批，每批 PROBE_CONCURRENCY 个）
  let added = 0;
  for (let i = 0; i < batch.length && active.length < POOL_SIZE; i += PROBE_CONCURRENCY) {
    const slice = batch.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(
      slice.map((c) => probe(c.item.address, c.url, c.proto).then((r) => ({ ...c, result: r }))),
    );
    for (const c of results) {
      if (!c.result.ok) {
        blacklistAdd(c.item.address);
        console.log(`[探-] ${c.item.address} (${c.result.reason})`);
        continue;
      }
      if (active.length >= POOL_SIZE) break;
      console.log(`[探] ${c.item.address} (${c.result.latencyMs}ms)`);
      active.push({
        addr: c.item.address,
        url: c.url,
        proto: c.proto,
        state: 'active',
        busy: 0,
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        lastUsedAt: 0,
        avgLatencyMs: c.result.latencyMs ?? 0,
      });
      added++;
    }
  }
  if (batch.length > 0) {
    console.log(`[填] active ${active.length}/${POOL_SIZE} (added ${added}, failed ${batch.length - added})`);
  }
}

function scheduleRefill(): void {
  if (refillInProgress) return;
  refillInProgress = true;
  Promise.resolve()
    .then(async () => {
      if (candidates.length === 0) await loadCandidates();
      await fillActive();
      // 池子仍不够：再补一轮
      if (active.length < POOL_LOW_THRESHOLD && candidates.length > 0) {
        await fillActive();
      }
    })
    .catch((e: any) => {
      console.error(`[填] refill error: ${e.message}`);
    })
    .finally(() => {
      refillInProgress = false;
      // 补位结束后如果池子仍低，再触发一轮
      if (active.length < POOL_LOW_THRESHOLD) scheduleRefill();
    });
}

/** 轮询选一个未满的活跃代理 */
function acquireProxy(): ActiveProxy | null {
  if (active.length === 0) return null;
  for (let i = 0; i < active.length; i++) {
    const j = rrCursor % active.length;
    rrCursor = (j + 1) % active.length;
    const p = active[j];
    if (p.state !== 'active') continue;
    if (p.busy >= MAX_CONCURRENT_PER_PROXY) continue;
    p.busy++;
    p.lastUsedAt = Date.now();
    return p;
  }
  // 全部饱和：选最闲的一个软溢出（带上限保护）
  const least = active
    .filter((a) => a.state === 'active' && a.busy < SOFT_OVERFLOW_MAX)
    .sort((a, b) => a.busy - b.busy)[0];
  if (least) {
    least.busy++;
    least.lastUsedAt = Date.now();
    console.log(`[满] all ${active.length} saturated — soft-overflow on ${least.addr} (busy=${least.busy})`);
    return least;
  }
  return null;
}

function releaseProxy(p: ActiveProxy): void {
  p.busy = Math.max(0, p.busy - 1);
  // replacing 状态且无在飞请求：彻底移除
  if (p.state === 'replacing' && p.busy === 0) {
    const idx = active.indexOf(p);
    if (idx >= 0) active.splice(idx, 1);
    console.log(`[死] ${p.addr} (drained)`);
  }
}

function penalize(addr: string, reason: string): void {
  const p = active.find((a) => a.addr === addr);
  if (!p) return;
  p.consecutiveFailures++;
  p.totalFailures++;
  console.log(`[罚] ${addr} (consec=${p.consecutiveFailures}, reason=${reason})`);
  if (p.consecutiveFailures >= PROXY_FAILURE_THRESHOLD) {
    retire(addr);
  }
}

function retire(addr: string): void {
  const idx = active.findIndex((a) => a.addr === addr);
  if (idx < 0) return;
  const p = active[idx];
  blacklistAdd(addr);
  if (p.busy === 0) {
    active.splice(idx, 1);
    console.log(`[死] ${addr} (retired, totalFailures=${p.totalFailures})`);
  } else {
    p.state = 'replacing';
    console.log(`[退] ${addr} (consec=${p.consecutiveFailures}, busy=${p.busy}) → replacing`);
  }
  scheduleRefill();
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  请求处理
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

function collectHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = {};
  for (const k of FORWARD) {
    if (k === 'authorization') continue; // authorization 始终用 public
    const v = req.headers.get(k);
    if (v) h[k] = v;
  }
  h['authorization'] = 'Bearer public';
  if (!h['x-opencode-client']) h['x-opencode-client'] = 'cli';
  if (!h['content-type']) h['content-type'] = 'application/json';
  return h;
}

/** 非流式请求 */
function doHttps(
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  agent: https.Agent,
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

/** 流式请求 — 返回 ReadableStream 给 Bun Response */
function doHttpsStream(
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  agent: https.Agent,
): Promise<{ status: number; stream: ReadableStream<Uint8Array> }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${UPSTREAM}${path}`,
      { method, headers, agent, timeout: STREAM_TIMEOUT, rejectUnauthorized: false },
      (res) => {
        // 流结束/出错时释放 agent（避免原代码的 agent 泄漏）
        res.on('end', () => {
          try {
            agent.destroy();
          } catch {}
        });
        res.on('error', () => {
          try {
            agent.destroy();
          } catch {}
        });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on('end', () => controller.close());
            res.on('error', (err) => controller.error(err));
          },
          cancel() {
            res.destroy();
          },
        });
        resolve({ status: res.statusCode || 200, stream });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 给流式响应包一层：错误/取消时给代理记一笔，流结束时释放 busy */
function wrapStreamWithPenalty(stream: ReadableStream<Uint8Array>, addr: string, onRelease: () => void): ReadableStream<Uint8Array> {
  let released = false;
  const safeRelease = () => { if (!released) { released = true; onRelease(); } };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            safeRelease();
            return;
          }
          controller.enqueue(value);
        }
      } catch (e: any) {
        penalize(addr, `stream-error: ${e.message ?? e}`);
        safeRelease();
        controller.error(e);
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    },
    cancel(reason) {
      penalize(addr, `client-cancel: ${reason ?? ''}`);
      safeRelease();
      try {
        stream.cancel();
      } catch {}
    },
  });
}

/** 核心：轮询拿一个代理，失败时换代理重试；池空走 ZenProxy fallback */
async function dispatch(
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  retry = 0,
): Promise<Response> {
  if (FORCE_RELAY) {
    if (ZENPROXY_KEY) return proxyViaRelay(path, method, headers, body);
    return new Response(
      '{"error":"FORCE_RELAY 但未配置 ZENPROXY_KEY"}',
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  // 候选池空：尝试加载
  if (candidates.length === 0) await loadCandidates();

  // 活跃池空：尝试同步填充一次
  if (active.length === 0) {
    await fillActive();
  }

  // 池子偏低：异步补位（不阻塞当前请求）
  if (active.length < POOL_LOW_THRESHOLD) scheduleRefill();

  const p = acquireProxy();
  if (!p) {
    if (ZENPROXY_KEY) {
      console.log(`[回退] 无可用代理 → ZenProxy relay`);
      return proxyViaRelay(path, method, headers, body);
    }
    return new Response(
      '{"error":"没有可用代理"}',
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  console.log(`[取] ${p.addr} (busy=${p.busy}/${MAX_CONCURRENT_PER_PROXY})`);

  const isStream = (headers['accept'] || '').includes('event-stream');
  const agent = makeAgent(p.url, p.proto);

  try {
    if (isStream) {
      // 流式：在流结束/错误时释放 proxy busy，而非立即释放
      const { stream } = await doHttpsStream(path, method, headers, body, agent);
      return new Response(wrapStreamWithPenalty(stream, p.addr, () => releaseProxy(p)), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }

    const { status, body: respBody } = await doHttps(path, method, headers, body, agent);
    try {
      agent.destroy();
    } catch {}

    // 上游 5xx：代理没毛病，不罚分，直接返回错误给客户端
    if (status >= 500) {
      releaseProxy(p);
      p.totalSuccesses++;
      p.consecutiveFailures = 0;
      return new Response(respBody, {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    releaseProxy(p);
    p.totalSuccesses++;
    p.consecutiveFailures = 0;

    return new Response(respBody, {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (e: any) {
    console.error(`[错] ${p.addr}: ${e.message}`);
    try {
      agent.destroy();
    } catch {}
    releaseProxy(p);
    penalize(p.addr, e.message);

    if (retry < MAX_RETRIES) {
      return dispatch(path, method, headers, body, retry + 1);
    }
    if (ZENPROXY_KEY) {
      console.log(`[回退] 重试耗尽 → ZenProxy relay`);
      return proxyViaRelay(path, method, headers, body);
    }
    return new Response(JSON.stringify({ error: `所有代理失败: ${e.message}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/** 回退通道：通过 ZenProxy /api/relay 转发（无代理也能用）
 *  关键：剥离 Authorization 头（Bearer public 会被 opencode 拒）
 *        同时把请求体作为 POST 转发给 relay
 */
async function proxyViaRelay(
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<Response> {
  // 剥离会破坏转发的头
  const clean: Record<string, string> = { ...headers };
  delete clean['host'];
  delete clean['content-length'];
  delete clean['authorization']; // 始终剥离，由 relay 端处理鉴权

  const target = `${UPSTREAM}${path}`;
  const url =
    `${ZENPROXY_RELAY}?api_key=${encodeURIComponent(ZENPROXY_KEY)}` +
    `&url=${encodeURIComponent(target)}&method=${method}`;

  const res = await fetch(url, {
    method: 'POST',  // relay 端点固定用 POST 接收
    headers: clean,
    body: body,      // GET 时 body 为 undefined
  });

  // 原样透传上游响应（含 SSE 流）
  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  路由
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

/** 路径归一化: /openai/v1/* 或 /anthropic/v1/* → /v1/* */
function normalize(raw: string): string | null {
  const m = raw.match(/^\/(openai|anthropic)(\/v1\/.+)$/);
  if (m) return m[2];
  return null;
}

// ––––––––––––––––––––––––––––––––––––––––––––––––––––
//  服务
// ––––––––––––––––––––––––––––––––––––––––––––––––––––

console.log(`[门] http://localhost:${PORT}`);
console.log(`[门] OpenAI:    /openai/v1/chat/completions | /openai/v1/models`);
console.log(`[门] Anthropic: /anthropic/v1/messages`);
console.log(`[门] 备用:      ${ZENPROXY_KEY ? `ZenProxy relay 已启用 (${ZENPROXY_RELAY})` : '未配置 ZENPROXY_KEY'}`);
console.log(`[门] 池:        POOL_SIZE=${POOL_SIZE}, MAX_CONCURRENT_PER_PROXY=${MAX_CONCURRENT_PER_PROXY}, FAILURE_THRESHOLD=${PROXY_FAILURE_THRESHOLD}`);
console.log(`[门] 溢出:      SOFT_OVERFLOW_MAX=${SOFT_OVERFLOW_MAX}, PROBE_CONCURRENCY=${PROBE_CONCURRENCY}, BLACKLIST_TTL=${BLACKLIST_TTL}ms`);

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
          JSON.stringify({ status: 'ok', proxies: active.length, pool_size: POOL_SIZE }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        '{"error":"not found"}',
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }

    if (pathname === '/v1/models' && method === 'GET') {
      return dispatch(pathname + search, 'GET', collectHeaders(req));
    }

    if (
      (pathname === '/v1/chat/completions' || pathname === '/v1/messages') &&
      method === 'POST'
    ) {
      let body = await req.text();
      const h = collectHeaders(req);
      const isStream =
        h['accept']?.includes('event-stream') ||
        (() => {
          try {
            return JSON.parse(body).stream;
          } catch {
            return false;
          }
        })();
      if (isStream) {
        h['accept'] = 'text/event-stream';
        try {
          const json = JSON.parse(body);
          if (!json.stream) {
            json.stream = true;
            body = JSON.stringify(json);
          }
        } catch {}
      }
      return dispatch(pathname, 'POST', h, body);
    }

    return new Response(
      '{"error":"not found"}',
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  },
});

// 启动：加载候选 + 探活填充活跃池
loadCandidates()
  .then(() => fillActive())
  .catch((e) => console.error('[门] initial fill failed:', e));

// 定期刷新候选 + 补位活跃池
const refreshTimer = setInterval(() => {
  loadCandidates()
    .then(() => fillActive())
    .catch((e) => console.error('[门] periodic refresh failed:', e));
}, PROXY_REFRESH_MS);

// 优雅退出
function shutdown(signal: string) {
  console.log(`[门] ${signal} received, shutting down...`);
  clearInterval(refreshTimer);
  // 等待在飞请求完成（最多 5s）
  const deadline = Date.now() + 5000;
  const wait = () => {
    const inflight = active.reduce((s, p) => s + p.busy, 0);
    if (inflight > 0 && Date.now() < deadline) {
      setTimeout(wait, 200);
    } else {
      process.exit(0);
    }
  };
  wait();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
