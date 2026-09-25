/**
 * 契约 A/B 的可复用实现：回环 feed（quota.json）+ CDP 巡检注入控件。
 * CLI provider 与 Electron 桌面版共用一份，避免两套实现漂移。
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const STATE_DIR = join(homedir(), '.miraquota');
const TOKEN_FILE = join(STATE_DIR, 'feed.token');

export const FEED_LO = 4988;
export const FEED_HI = 4995;
export const DEFAULT_CDP_PORTS = [9333, 9222];
const SWEEP_MS = 10_000, SWEEP_IDLE_MS = 30_000, STEADY_ROUNDS = 3;

export function feedToken() {
  try { const e = readFileSync(TOKEN_FILE, 'utf8').trim(); if (e.length >= 16) return e; } catch { /* 首次 */ }
  const fresh = randomBytes(16).toString('hex');
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, fresh);
  return fresh;
}

/**
 * 控件读的那几个字段（契约 A 的必填四项 windows / capturedAt / state / stateLabel 之外，控件实际用到的）。
 * 控件要新字段时加到这里——别图省事把整份 payload 放出去。
 */
const WIDGET_FIELDS = ['state', 'stateLabel', 'measured', 'capturedAt', 'mode', 'host', 'relayStatus', 'pricing',
  'buckets', 'windows', 'speed', 'detail', 'accountNotice', 'unitPriceUSD', 'unitPriceNotice', 'ledgerPerPoint'];

/**
 * feed 对外的那一份：只留控件读的字段。
 *
 * feed 是 `Access-Control-Allow-Origin: *` 且 GET 不鉴权（控件跑在 Mirasim 的页面里跨域来取），
 * 这台机器上**任何网页**都读得到它。所以 fleet-dao 的地址与账号池、账目报表（工作区路径、会话 id）、
 * 收件口地址与名字这些，一律不进——控件用不上，放出去就是白送（审查 2026-09-25 指出）。
 * 多机只留控件画「多机 ×N」要的状态与台数。
 */
export function widgetPayload(p) {
  const out = {};
  for (const k of WIDGET_FIELDS) if (p?.[k] !== undefined) out[k] = p[k];
  if (p?.sync) out.sync = { state: p.sync.state, machines: (p.sync.machines ?? []).map((m) => ({ self: !!m.self })) };
  return out;
}

/** 契约 A：回环 feed。`payload` 为取数函数（给整份，这里裁成控件那一份）；`onQuit` 不给则 /quit 不开。 */
export function startFeed({ payload, onQuit = null, explicitPort = 0 }) {
  const token = feedToken();
  const server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    const head = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'X-MiraQuota-Token',
      'Cache-Control': 'no-store',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, head); return res.end(); }
    if (path === '/quota.json' && req.method === 'GET') {
      res.writeHead(200, { ...head, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(widgetPayload(payload())));
    }
    if (path === '/quit' && req.method === 'POST' && onQuit) {
      if (req.headers['x-miraquota-token'] !== token) { res.writeHead(403, head); return res.end(); }
      res.writeHead(200, { ...head, 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return setTimeout(onQuit, 200);
    }
    res.writeHead(404, head); res.end();
  });
  return new Promise((resolve, reject) => {
    let port = explicitPort || FEED_LO;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && !explicitPort && port < FEED_HI) server.listen(++port, '127.0.0.1');
      else reject(e);
    });
    server.on('listening', () => resolve({ server, port }));
    server.listen(port, '127.0.0.1');
  });
}

const getJSON = async (url, ms = 2500) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

function cdp(socketUrl, commands, wantId) {
  return new Promise((resolve) => {
    let ws;
    const done = (v) => { try { ws && ws.close(); } catch { /* closed */ } resolve(v); };
    const timer = setTimeout(() => done(null), 6000);
    try { ws = new WebSocket(socketUrl); } catch { clearTimeout(timer); return resolve(null); }
    ws.addEventListener('error', () => { clearTimeout(timer); done(null); });
    ws.addEventListener('open', () => { for (const c of commands) ws.send(JSON.stringify(c)); });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id === wantId) { clearTimeout(timer); done(msg); }
    });
  });
}

/** 契约 B：CDP 巡检注入。start(feedPort) 后自循环，stop() 停。 */
export class Injector {
  constructor({ widgetPath, cdpPorts = DEFAULT_CDP_PORTS, log = () => {} }) {
    this.cdpPorts = cdpPorts;
    this.log = log;
    this.widgetPath = widgetPath;
    this.source = existsSync(widgetPath) ? readFileSync(widgetPath, 'utf8') : null;
    this.version = this.source ? Number((this.source.match(/const VERSION = (\d+)/) || [])[1] || 0) : 0;
    this.registered = new Set();
    this.steady = 0;
    this.timer = null;
    this.stopped = false;
  }

  get hasWidget() { return !!this.source; }

  start(feedPort) {
    if (!this.source) return this.log(`控件脚本不存在，注入跳过：${this.widgetPath}`);
    this.stopped = false;
    this.#sweep(feedPort).catch((e) => this.log('注入异常 ' + e.message));
  }

  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  async #sweep(feedPort) {
    let targets = null, cdpPort = null;
    for (const p of this.cdpPorts) {
      const list = await getJSON(`http://127.0.0.1:${p}/json`);
      if (Array.isArray(list)) { targets = list; cdpPort = p; break; }
    }
    if (!targets) {
      this.steady = 0;
      return this.#reschedule(feedPort, SWEEP_MS, `找不到调试端口（试过 ${this.cdpPorts.join('、')}）`);
    }

    // 自家面板（file://…/app/renderer/index.html）不注入——带调试端口跑 dev 时会被自己巡检命中
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl
      && !/miraquota.*\/app\/renderer\/index\.html$/i.test(String(t.url || '')));
    const script = `window.__MIRAQUOTA_FEED__="http://127.0.0.1:${feedPort}";\n` + this.source;
    let hits = 0, injected = 0;

    for (const t of pages) {
      const probe = await cdp(t.webSocketDebuggerUrl, [{
        id: 1, method: 'Runtime.evaluate',
        params: { expression: 'window.__miraquotaVersion||0', returnByValue: true },
      }], 1);
      const seen = Number(probe?.result?.result?.value || 0);
      if (seen >= this.version) { hits++; continue; }
      const commands = [{ id: 1, method: 'Page.enable' }];
      if (!this.registered.has(t.id)) {
        commands.push({ id: 2, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: script } });
      }
      commands.push({ id: 3, method: 'Runtime.evaluate',
        params: { expression: script, awaitPromise: false, returnByValue: false } });
      const reply = await cdp(t.webSocketDebuggerUrl, commands, 3);
      if (reply && !reply.result?.exceptionDetails) { this.registered.add(t.id); injected++; hits++; }
    }

    this.steady = injected === 0 && hits === pages.length && pages.length > 0 ? this.steady + 1 : 0;
    const wait = this.steady >= STEADY_ROUNDS ? SWEEP_IDLE_MS : SWEEP_MS;
    this.#reschedule(feedPort, wait, `cdp ${cdpPort} · 页面 ${pages.length} · 已带控件 ${hits} · 本轮注入 ${injected}`);
  }

  #reschedule(feedPort, wait, note) {
    if (this.stopped) return;
    this.log(`注入 ${note}`);
    this.timer = setTimeout(() => this.#sweep(feedPort).catch((e) => this.log('注入异常 ' + e.message)), wait);
  }
}
