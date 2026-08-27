#!/usr/bin/env node
/**
 * MiraQuota Windows provider —— 把额度控件放进 Mirasim 桌面客户端界面。
 *
 * 按 docs/ARCHITECTURE.md 的两份契约实现：
 *   契约 A  在回环 HTTP 上挂 quota.json
 *   契约 B  CDP 巡检，把 widget.js 注入 Mirasim 渲染进程
 *
 * 相对上游 Node 参考 provider 的增量（还原 mac 版有而参考实现缺的那一半）：
 *   - 会话令牌自动发现：PEB 内存读取（见 lib/session-token.mjs），无需手工传令牌；
 *   - 美元折算、每点单价、满额标定、打满外推：解析本机账本（lib/ledger + calibrator + coherence）；
 *   - 出字速度与首 token、在途「生成中」：lib/speed。
 *
 * 依赖只有 Node 内置件（fetch 与 WebSocket 自 Node 22 起是全局的）。
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { Pricing } from './lib/pricing.mjs';
import { CostLedger } from './lib/ledger.mjs';
import { Calibrator, CONFIDENCE, CONFIDENCE_LABEL } from './lib/calibrator.mjs';
import { evaluateCoherence, coherenceNotice } from './lib/coherence.mjs';
import { discoverSessionTokens } from './lib/session-token.mjs';
import { windowDuration, modelGroup } from './lib/windows.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(homedir(), '.miraquota');
const TOKEN_FILE = join(STATE_DIR, 'feed.token');

const FEED_LO = 4988, FEED_HI = 4995;
const CHANNEL_DEFAULT = 4970;
const POLL_MS = 15_000;
const SWEEP_MS = 10_000, SWEEP_IDLE_MS = 30_000, STEADY_ROUNDS = 3;
const STALE_AFTER = 90;         // 秒；采集超过此龄期转 stale
const LEVELS = { exact: '精确', live: '实时', stale: '已过期', local: '无数据', connecting: '连接中' };

/* ---------------- 参数 ---------------- */

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

/* ---------------- 进程与端口发现 ---------------- */

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 8000, maxBuffer: 8 << 20, windowsHide: true },
    (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
});

/** Mirasim 进程（pid 与命令行）。命令行里带 server.cjs 的才算。 */
async function mirasimProcesses() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*server.cjs*" } |' +
      ' Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress']);
    if (!out.trim()) return [];
    let parsed;
    try { parsed = JSON.parse(out); } catch { return []; }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((r) => ({ pid: Number(r.ProcessId), cmd: String(r.CommandLine || '') }));
  }
  const out = await run('/bin/ps', ['-axo', 'pid=,command=']);
  return out.split('\n').filter((l) => l.includes('server.cjs')).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), cmd: m[2] } : null;
  }).filter(Boolean);
}

/** 指定 pid 集合持有的回环监听端口。 */
async function listeningPorts(pids) {
  const byPid = new Map(pids.map((p) => [p, []]));
  const add = (pid, port) => { if (byPid.has(pid)) byPid.get(pid).push(port); };
  if (process.platform === 'win32') {
    const out = await run('netstat.exe', ['-ano', '-p', 'TCP']);
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m) add(Number(m[2]), Number(m[1]));
    }
  } else if (process.platform === 'darwin') {
    const out = await run('/usr/sbin/lsof',
      ['-nP', '-w', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(','), '-Fpn']);
    let current = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) current = Number(line.slice(1));
      else if (line.startsWith('n127.0.0.1:') && current != null) add(current, Number(line.slice(11)));
    }
  } else {
    const out = await run('ss', ['-Hltnp']);
    for (const line of out.split('\n')) {
      const port = line.match(/127\.0\.0\.1:(\d+)/);
      const pid = line.match(/pid=(\d+)/);
      if (port && pid) add(Number(pid[1]), Number(port[1]));
    }
  }
  return byPid;
}

const getJSON = async (url, ms = 2500, headers = undefined) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

async function discoverChannelPort(processes) {
  const verify = async (p) => {
    const j = await getJSON(`http://127.0.0.1:${p}/api/health`);
    return j && j.name === 'mirasim' ? p : null;
  };
  const explicit = Number(opt('channel-port', 0));
  if (explicit) return (await verify(explicit)) || explicit;
  const fromCmd = processes.map((p) => p.cmd.match(/--port[= ](\d+)/)).filter(Boolean).map((m) => Number(m[1]));
  for (const p of [...new Set([...fromCmd, CHANNEL_DEFAULT])]) if (await verify(p)) return p;
  for (let p = 4970; p <= 4980; p++) if (await verify(p)) return p;
  return null;
}

/* ---------------- /v1/limits 发现与解析 ---------------- */

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** 解析 /v1/limits 返回。reset_at 归一化，越界窗口丢弃。 */
function parseLimits(root) {
  if (!root || !Array.isArray(root.windows)) return null;
  const now = Date.now() / 1000;
  const windows = [];
  for (const w of root.windows) {
    const used = num(w.used), budget = num(w.budget);
    let reset = num(w.reset_at);
    if (used == null || budget == null || budget <= 0 || reset == null || !w.name) continue;
    if (reset > 1e11) reset /= 1000;
    if (reset < now - 86400 || reset > now + 30 * 86400) continue;
    const scoped = (w.model_scoped === true) || (w.modelScoped === true);
    windows.push({ label: String(w.name), used, budget, resetAt: reset, modelScoped: scoped });
  }
  if (!windows.length) return null;
  return {
    windows,
    suspended: !!root.suspended, unmetered: !!root.unmetered, degraded: !!root.degraded,
  };
}

let cachedRouter = null;   // { port, token }

/**
 * 找到挂着 /v1/limits 的路由端口与令牌。
 * 令牌来源优先级：显式参数/环境 → PEB 自动发现（Windows）→ 免认证（旧版）。
 */
async function discoverRouter(processes, channelPort) {
  const explicitPort = Number(opt('router-port', 0));
  const explicitToken = opt('router-token', process.env.MIRAQUOTA_ROUTER_TOKEN) || null;

  // 缓存命中先复用。
  if (cachedRouter) {
    const s = parseLimits(await getJSON(`http://127.0.0.1:${cachedRouter.port}/v1/limits`, 2500,
      cachedRouter.token ? { 'x-api-key': cachedRouter.token } : undefined));
    if (s) return cachedRouter;
    cachedRouter = null;
  }

  // 候选 (port, token) 配对。
  const pairs = [];
  if (explicitPort) pairs.push({ port: explicitPort, token: explicitToken });
  const discovered = explicitToken ? [] : await discoverSessionTokens();  // PEB
  const tokenByPort = new Map(discovered.map((d) => [d.port, d.token]));

  // Mirasim 进程持有的回环端口，逐个配上对应令牌。
  if (processes.length) {
    const byPid = await listeningPorts(processes.map((p) => p.pid));
    let ports = null;
    for (const [, list] of byPid) if (channelPort != null && list.includes(channelPort)) { ports = list; break; }
    if (!ports) ports = [...byPid.values()].flat();
    const ordered = [...new Set(ports)].sort((a, b) => (a === channelPort ? 1 : 0) - (b === channelPort ? 1 : 0));
    for (const p of ordered) pairs.push({ port: p, token: explicitToken ?? tokenByPort.get(p) ?? null });
  }
  // PEB 发现的端口即便不在监听枚举里也试一遍（会话端口可能刚起来）。
  for (const d of discovered) if (!pairs.some((x) => x.port === d.port)) pairs.push({ port: d.port, token: d.token });

  for (const pair of pairs) {
    const headers = pair.token ? { 'x-api-key': pair.token } : undefined;
    if (parseLimits(await getJSON(`http://127.0.0.1:${pair.port}/v1/limits`, 2500, headers))) {
      cachedRouter = pair;
      return pair;
    }
  }
  return null;
}

/* ---------------- 采集与组装 ---------------- */

const pricing = new Pricing();
const ledger = new CostLedger(pricing);
const calibrator = new Calibrator();
let speed = null;   // lib/speed.mjs 可用时挂上（见启动段）

// 速度模块的异常不得拖垮额度主线（额度不依赖它）：刷新与取数都包一层。
function safeSpeedRefresh() { if (speed) try { speed.refresh(); } catch { /* 忽略 */ } }
function safeSpeedReport() { if (!speed) return null; try { return speed.report(); } catch { return null; } }

let last = null;              // { at, limits }
const pointsTrail = {};      // label → [{ at, used, resetAt }]

function recordTrail(limits, nowSec) {
  for (const w of limits.windows) {
    const list = pointsTrail[w.label] ?? (pointsTrail[w.label] = []);
    if (list.length && list[list.length - 1].at >= nowSec) continue;
    list.push({ at: nowSec, used: w.used, resetAt: w.resetAt });
    const cutoff = nowSec - 7200;
    while (list.length && list[0].at < cutoff) list.shift();
  }
}

/** 按近 1 小时点增速外推打满秒数。 */
function etaSeconds(w, nowSec) {
  const trail = (pointsTrail[w.label] ?? []).filter((p) => p.resetAt === w.resetAt && nowSec - p.at <= 3600);
  if (trail.length < 2) return null;
  const first = trail[0], lastp = trail[trail.length - 1];
  if (lastp.at - first.at < 180) return null;
  const rate = (lastp.used - first.used) / (lastp.at - first.at);
  if (rate <= 0) return null;
  return (w.budget - lastp.used) / rate;
}

async function collect() {
  const processes = await mirasimProcesses();
  const channelPort = await discoverChannelPort(processes);
  const router = await discoverRouter(processes, channelPort);
  const limits = router
    ? parseLimits(await getJSON(`http://127.0.0.1:${router.port}/v1/limits`, 2500,
        router.token ? { 'x-api-key': router.token } : undefined))
    : null;
  if (limits) {
    const nowSec = Date.now() / 1000;
    recordTrail(limits, nowSec);
    calibrator.record(limits.windows, nowSec);
    ledger.adoptScopedGroups(limits.windows.filter((w) => w.modelScoped).map((w) => modelGroup(w.label)).filter(Boolean));
    last = { at: nowSec, limits };
  }
  ledger.refresh();
  safeSpeedRefresh();
  return last;
}

/** 组装契约 A 的 quota.json。 */
function payload() {
  const now = Date.now() / 1000;
  if (!last) {
    return {
      state: 'local', stateLabel: LEVELS.local, measured: false, capturedAt: now, windows: [],
      detail: '未取到 Mirasim 的额度接口：确认 Mirasim 正在运行。',
      speed: safeSpeedReport(),
    };
  }
  const stale = now - last.at > STALE_AFTER;
  const level = stale ? 'stale' : 'exact';
  const limits = last.limits;
  const coherence = evaluateCoherence(limits.windows, ledger, now);
  const rate = coherence.perPoint;

  const windows = limits.windows.map((w) => {
    const usedPercent = Math.min(100, w.used / w.budget * 100);
    const group = w.modelScoped ? modelGroup(w.label) : null;
    const dur = windowDuration(w.label);
    const start = dur ? w.resetAt - dur : null;
    const spent = start != null ? ledger.spent(start, now, { includeOpenMinute: true, group }) : 0;
    const est = calibrator.estimate(w.label, ledger, w.budget, group);

    let fullUSD = null, confidence = 'none';
    if (est && (est.confidence === 'high' || est.confidence === 'medium')) {
      fullUSD = est.fullUSD; confidence = est.confidence;
    } else if (rate != null) {
      fullUSD = rate * w.budget; confidence = 'low';
    } else if (est) {
      fullUSD = est.fullUSD; confidence = est.confidence;
    }

    const paceDelta = start != null && dur
      ? usedPercent - Math.min(100, Math.max(0, (now - start) / dur * 100)) : null;

    return {
      label: w.label,
      usedPercent,
      inferred: false,
      confidence,
      sampleCount: est?.observations ?? 0,
      spentUSD: spent,
      ...(fullUSD != null ? { fullUSD } : {}),
      ...(fullUSD != null ? { scaledSpentUSD: fullUSD * usedPercent / 100 } : {}),
      ...(fullUSD != null ? { remainingUSD: Math.max(0, fullUSD * (100 - usedPercent) / 100) } : {}),
      points: { used: w.used, budget: w.budget },
      resetAt: w.resetAt,
      ...(paceDelta != null ? { pacePercent: Math.min(100, Math.max(0, (now - start) / dur * 100)), paceDelta } : {}),
      ...(etaSeconds(w, now) != null ? { etaSeconds: etaSeconds(w, now) } : {}),
      ...(group ? { modelGroup: group } : {}),
    };
  });

  const notice = limits.suspended ? '账号被暂停，额度数字仅供参考'
    : limits.unmetered ? '账号不计量，额度上限不适用'
    : limits.degraded ? '上游降级运行中' : null;

  const out = {
    state: level,
    stateLabel: LEVELS[level],
    measured: true,
    capturedAt: last.at,
    mode: '-', host: '-', relayStatus: '-',
    pricing: pricing.source,
    buckets: ledger.bucketCount,
    windows,
    speed: safeSpeedReport(),
  };
  if (rate != null) out.unitPriceUSD = rate;
  else { const n = coherenceNotice(coherence); if (n) out.unitPriceNotice = n; }
  if (notice) out.accountNotice = notice;
  if (stale) out.detail = `Mirasim 已 ${Math.round((now - last.at) / 60)} 分钟未回传，显示最后一次实测值`;
  return out;
}

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
      return res.end(JSON.stringify(payload()));
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
  console.log(`通道 ${p.stateLabel}${p.accountNotice ? ' · ' + p.accountNotice : ''} · 价目表 ${p.pricing ?? '-'} · 分钟桶 ${p.buckets ?? 0}`);
  if (p.unitPriceUSD != null) console.log(`单价 ${p.unitPriceUSD.toFixed(6)} 美元/额度点（账本支出 ÷ 已用点数反推）`);
  else if (p.unitPriceNotice) console.log(`单价 ${p.unitPriceNotice}`);
  if (!p.windows.length) return console.log('无窗口');
  for (const w of p.windows) {
    const full = w.fullUSD != null ? `$${w.fullUSD.toFixed(0)}` : '标定中';
    const conf = CONFIDENCE_LABEL[w.confidence] ?? w.confidence;
    const pd = w.paceDelta == null ? '' : `  均速偏离 ${w.paceDelta >= 0 ? '+' : ''}${w.paceDelta.toFixed(1)}%`;
    const scaled = w.scaledSpentUSD != null ? w.scaledSpentUSD : w.spentUSD;
    console.log(`${w.label.padEnd(9)} ${w.usedPercent.toFixed(1).padStart(5)}%  已用 $${scaled.toFixed(2)} / ${full}  ${Math.round(w.points.used)}/${Math.round(w.points.budget)} 点${pd}  观测 ${w.sampleCount}(${conf})  ${fmtReset(w.resetAt)}`);
    if (w.scaledSpentUSD != null) console.log(`          账本支出 $${w.spentUSD.toFixed(2)}`);
    if (w.remainingUSD != null) {
      const eta = w.etaSeconds != null ? ` · 按近 1 小时点增速 ≈${(w.etaSeconds / 3600).toFixed(1)} 小时后满` : '';
      console.log(`          余 $${w.remainingUSD.toFixed(0)}${eta}`);
    }
  }
  if (p.speed?.rows?.length) {
    for (const r of p.speed.rows) {
      const ttft = r.ttft != null ? `首 ≈${r.ttft.toFixed(1)}s` : '首 -';
      const rate = r.rate != null ? `出字 ${r.rate.toFixed(0)} tok/s` : '出字 -';
      const drift = r.driftNotable != null ? ` · 较常态 ${r.driftNotable >= 0 ? '+' : ''}${r.driftNotable.toFixed(0)}%` : '';
      console.log(`速度 ${r.model}  ${ttft} · ${rate} · 端到端 ${r.endToEnd.toFixed(0)} tok/s · 最近 ${r.samples} 次${drift}`);
    }
  }
  if (p.speed?.inflightSince?.length) {
    console.log(`速度 ▶ 生成中 ${p.speed.inflightSince.length} 条`);
  }
}

/* ---------------- 启动 ---------------- */

// speed.mjs 由子代理并行产出，可能尚未就绪；缺席时功能照常，只是无速度卡。
try {
  const mod = await import('./lib/speed.mjs');
  if (mod?.SpeedStats) speed = new mod.SpeedStats();
} catch { /* 速度模块未就绪，跳过 */ }

if (flag('once')) {
  await collect();
  printSnapshot(payload());
  process.exit(last ? 0 : 1);
}

const { server, port: feedPort } = await startFeed(() => shutdown(0));
log(`feed http://127.0.0.1:${feedPort}/quota.json`);
if (widgetSource) log(`控件 v${widgetVersion} ${widgetPath}`);
else log(`控件脚本不存在，注入跳过：${widgetPath}`);

await collect();
printSnapshot(payload());
const pollTimer = setInterval(() => collect().catch(() => {}), POLL_MS);
if (!flag('no-inject')) sweep(feedPort).catch((e) => log('注入异常 ' + e.message));

function shutdown(code) {
  clearInterval(pollTimer);
  if (sweepTimer) clearTimeout(sweepTimer);
  server.close();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
