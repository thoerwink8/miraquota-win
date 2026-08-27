#!/usr/bin/env node
/**
 * MiraQuota Windows provider（CLI 形态）—— 把额度控件注入 Mirasim 客户端界面。
 *
 * 数据引擎在 lib/engine.mjs（与 Electron 桌面版共用）；本文件只做三件事：
 *   契约 A  回环 HTTP 上挂 quota.json
 *   契约 B  CDP 巡检注入 widget.js
 *   --once  取一次并打印
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { Engine } from './lib/engine.mjs';
import { CONFIDENCE_LABEL } from './lib/calibrator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(homedir(), '.miraquota');
const TOKEN_FILE = join(STATE_DIR, 'feed.token');

const FEED_LO = 4988, FEED_HI = 4995;
const POLL_MS = 15_000;
const SWEEP_MS = 10_000, SWEEP_IDLE_MS = 30_000, STEADY_ROUNDS = 3;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

if (flag('help') || flag('h')) {
  console.log(`用法 node miraquota-provider.mjs [选项]

  --once                取一次并打印，不起服务、不注入
  --no-inject           只提供 feed，不做 CDP 注入
  --offline             强制离线（验证锚点推算路径）
  --cdp-port <N>        Mirasim 的调试端口（默认试 MIRAQUOTA_CDP_PORT、9333、9222）
  --feed-port <N>       feed 端口（默认在 ${FEED_LO}–${FEED_HI} 里取第一个空闲的）
  --router-port <N>     直接指定挂着 /v1/limits 的路由端口，跳过发现
  --router-token <T>    /v1/limits 的会话令牌；不给则用 PEB 自动发现（Windows）
  --widget <路径>       控件脚本（默认 ../widget/miraquota-widget.js）`);
  process.exit(0);
}

const CDP_PORTS = (() => {
  const explicit = opt('cdp-port', process.env.MIRAQUOTA_CDP_PORT);
  return explicit ? [Number(explicit)] : [9333, 9222];
})();

const engine = new Engine({
  routerPort: opt('router-port', 0),
  routerToken: opt('router-token', process.env.MIRAQUOTA_ROUTER_TOKEN) || null,
  forceOffline: flag('offline'),
});
await engine.loadSpeed();

/* ---------------- 契约 A：feed ---------------- */

function feedToken() {
  try { const e = readFileSync(TOKEN_FILE, 'utf8').trim(); if (e.length >= 16) return e; } catch { /* 首次 */ }
  const fresh = randomBytes(16).toString('hex');
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, fresh);
  return fresh;
}

function startFeed(onQuit) {
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
      return res.end(JSON.stringify(engine.payload()));
    }
    if (path === '/quit' && req.method === 'POST') {
      if (req.headers['x-miraquota-token'] !== token) { res.writeHead(403, head); return res.end(); }
      res.writeHead(200, { ...head, 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return setTimeout(onQuit, 200);
    }
    res.writeHead(404, head); res.end();
  });
  return new Promise((resolve, reject) => {
    const explicit = Number(opt('feed-port', 0));
    let port = explicit || FEED_LO;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && !explicit && port < FEED_HI) server.listen(++port, '127.0.0.1');
      else reject(e);
    });
    server.on('listening', () => resolve({ server, port }));
    server.listen(port, '127.0.0.1');
  });
}

/* ---------------- 契约 B：注入 ---------------- */

const getJSON = async (url, ms = 2500) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

const widgetPath = opt('widget', join(HERE, '..', 'widget', 'miraquota-widget.js'));
const widgetSource = existsSync(widgetPath) ? readFileSync(widgetPath, 'utf8') : null;
const widgetVersion = widgetSource ? Number((widgetSource.match(/const VERSION = (\d+)/) || [])[1] || 0) : 0;

const registered = new Set();
let steady = 0, sweepTimer = null;

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

async function sweep(feedPort) {
  if (!widgetSource) return;
  let targets = null, cdpPort = null;
  for (const p of CDP_PORTS) {
    const list = await getJSON(`http://127.0.0.1:${p}/json`);
    if (Array.isArray(list)) { targets = list; cdpPort = p; break; }
  }
  if (!targets) { steady = 0; return reschedule(feedPort, SWEEP_MS, `找不到调试端口（试过 ${CDP_PORTS.join('、')}）`); }

  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const prelude = `window.__MIRAQUOTA_FEED__="http://127.0.0.1:${feedPort}";\n`;
  const script = prelude + widgetSource;
  let hits = 0, injected = 0;

  for (const t of pages) {
    const probe = await cdp(t.webSocketDebuggerUrl, [{
      id: 1, method: 'Runtime.evaluate',
      params: { expression: 'window.__miraquotaVersion||0', returnByValue: true },
    }], 1);
    const seen = Number(probe?.result?.result?.value || 0);
    if (seen >= widgetVersion) { hits++; continue; }
    const commands = [{ id: 1, method: 'Page.enable' }];
    if (!registered.has(t.id)) {
      commands.push({ id: 2, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: script } });
    }
    commands.push({ id: 3, method: 'Runtime.evaluate',
      params: { expression: script, awaitPromise: false, returnByValue: false } });
    const reply = await cdp(t.webSocketDebuggerUrl, commands, 3);
    if (reply && !reply.result?.exceptionDetails) { registered.add(t.id); injected++; hits++; }
  }

  steady = injected === 0 && hits === pages.length && pages.length > 0 ? steady + 1 : 0;
  const wait = steady >= STEADY_ROUNDS ? SWEEP_IDLE_MS : SWEEP_MS;
  reschedule(feedPort, wait, `cdp ${cdpPort} · 页面 ${pages.length} · 已带控件 ${hits} · 本轮注入 ${injected}`);
}

function reschedule(feedPort, wait, note) {
  log(`注入 ${note}`);
  sweepTimer = setTimeout(() => sweep(feedPort), wait);
}

/* ---------------- 打印与主流程 ---------------- */

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const fmtReset = (t) => {
  if (t == null) return '无重置';
  const left = Math.max(0, t - Date.now() / 1000);
  return left >= 86400 ? `重置 ${(left / 86400).toFixed(1)} 天`
    : `重置 ${String(Math.floor(left / 3600)).padStart(2, '0')}:${String(Math.floor(left % 3600 / 60)).padStart(2, '0')}`;
};

function printSnapshot(p) {
  console.log(`通道 ${p.stateLabel}${p.detail ? ' · ' + p.detail : ''}${p.accountNotice ? ' · ' + p.accountNotice : ''}`);
  console.log(`价目表 ${p.pricing ?? '-'} · 分钟桶 ${p.buckets ?? 0}`);
  if (p.unitPriceUSD != null) console.log(`单价 ${p.unitPriceUSD.toFixed(6)} 美元/额度点（账本支出 ÷ 已用点数反推）`);
  else if (p.unitPriceNotice) console.log(`单价 ${p.unitPriceNotice}`);
  if (!p.windows.length) return console.log('无窗口');
  for (const w of p.windows) {
    const full = w.fullUSD != null ? `$${w.fullUSD.toFixed(0)}` : '标定中';
    const conf = CONFIDENCE_LABEL[w.confidence] ?? w.confidence;
    const pd = w.paceDelta == null ? '' : `  均速偏离 ${w.paceDelta >= 0 ? '+' : ''}${w.paceDelta.toFixed(1)}%`;
    const scaled = w.scaledSpentUSD != null ? w.scaledSpentUSD : w.spentUSD;
    const mark = w.inferred ? '≈' : ' ';
    const pts = w.points ? `  ${Math.round(w.points.used)}/${Math.round(w.points.budget)} 点` : '';
    console.log(`${w.label.padEnd(9)}${mark}${w.usedPercent.toFixed(1).padStart(5)}%  已用 $${scaled.toFixed(2)} / ${full}${pts}${pd}  观测 ${w.sampleCount}(${conf})  ${fmtReset(w.resetAt)}`);
    if (w.scaledSpentUSD != null) console.log(`          账本支出 $${w.spentUSD.toFixed(2)}`);
    if (w.remainingUSD != null) {
      const eta = w.etaSeconds != null ? ` · 按近 1 小时点增速 ≈${(w.etaSeconds / 3600).toFixed(1)} 小时后满` : '';
      console.log(`          余 $${w.remainingUSD.toFixed(0)}${eta}`);
    }
  }
  for (const r of p.speed?.rows ?? []) {
    const ttft = r.ttft != null ? `首 ≈${r.ttft.toFixed(1)}s` : '首 -';
    const rate = r.rate != null ? `出字 ${r.rate.toFixed(0)} tok/s` : '出字 -';
    const drift = r.driftNotable != null ? ` · 较常态 ${r.driftNotable >= 0 ? '+' : ''}${r.driftNotable.toFixed(0)}%` : '';
    console.log(`速度 ${r.model}  ${ttft} · ${rate} · 端到端 ${r.endToEnd.toFixed(0)} tok/s · 最近 ${r.samples} 次${drift}`);
  }
  if (p.speed?.inflightSince?.length) console.log(`速度 ▶ 生成中 ${p.speed.inflightSince.length} 条`);
}

if (flag('once')) {
  await engine.poll();
  printSnapshot(engine.payload());
  process.exit(engine.last || engine.anchors.usable ? 0 : 1);
}

const { server, port: feedPort } = await startFeed(() => shutdown(0));
log(`feed http://127.0.0.1:${feedPort}/quota.json`);
if (widgetSource) log(`控件 v${widgetVersion} ${widgetPath}`);
else log(`控件脚本不存在，注入跳过：${widgetPath}`);

await engine.poll();
printSnapshot(engine.payload());
const pollTimer = setInterval(() => engine.poll().catch(() => {}), POLL_MS);
if (!flag('no-inject')) sweep(feedPort).catch((e) => log('注入异常 ' + e.message));

function shutdown(code) {
  clearInterval(pollTimer);
  if (sweepTimer) clearTimeout(sweepTimer);
  server.close();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
