#!/usr/bin/env node
/**
 * MiraQuota Windows provider（CLI 形态）—— 把额度控件注入 Mirasim 客户端界面。
 *
 * 数据引擎在 lib/engine.mjs（与 Electron 桌面版共用）；本文件只做三件事：
 *   契约 A  回环 HTTP 上挂 quota.json
 *   契约 B  CDP 巡检注入 widget.js
 *   --once  取一次并打印
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Engine } from './lib/engine.mjs';
import { CONFIDENCE_LABEL } from './lib/calibrator.mjs';
import { startFeed, Injector, FEED_LO, FEED_HI } from './lib/injector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLL_MS = 15_000;
// 无界面机器慢一档：它的产出是每 intervalSec 一次的分片，15 秒轮询只是白读账本。
const SYNC_ONLY_POLL_MS = 60_000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

if (flag('help') || flag('h')) {
  console.log(`用法 node miraquota-provider.mjs [选项]

  --once                取一次并打印，不起服务、不注入
  --sync-only           无界面机器（Linux 服务器）用：只读本机账本并同步分片，
                        不起 feed、不注入、不需要 Mirasim 调试端口
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
  if (p.unitPriceUSD != null) console.log(`单价 ${p.unitPriceUSD.toFixed(4)} 美元/额度点（官方：点数 ÷ 100）` + (p.ledgerPerPoint != null ? ` · 账本反推 ${p.ledgerPerPoint.toFixed(6)}` : ''));
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
  const u = p.sync?.usage;
  if (u) {
    for (const m of u.machines) {
      console.log(`${u.label} 机器 ${(m.id + (m.self ? '（本机）' : '')).padEnd(22)} ${Math.round(m.points).toLocaleString().padStart(9)} 点  $${m.usd.toFixed(2)}`);
    }
    for (const x of u.unpriced ?? []) console.log(`${u.label} 未定价 ${x.model.padEnd(20)} ${x.tokens.toLocaleString().padStart(9)} token`);
    if (u.unattributedPoints != null) {
      console.log(`${u.label} 机器 ${'未同步账本'.padEnd(18)} ${Math.round(u.unattributedPoints).toLocaleString().padStart(9)} 点  $${u.unattributedUSD.toFixed(2)}`);
    }
  }
  if (p.roster) {
    console.log(p.roster.unpriced.length ? `价目 已启用模型中无价：${p.roster.unpriced.join(', ')}` : `价目 已启用 ${p.roster.models.length} 个模型都有价`);
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

/**
 * 无界面机器（Linux 服务器）：这台机器上没有 Mirasim 界面可注入，也没人看 feed，
 * 它存在的唯一理由是把本机账本与速度作为分片发出去，让有界面的那台看得见。
 * 每轮只打一行现状——systemd journal 里能看出它活着、同步成没成。
 */
if (flag('sync-only')) {
  const line = () => {
    const p = engine.payload();
    const sy = p.sync;
    const spend = p.windows?.find((w) => w.label === '7d');
    const parts = [`账本 ${p.buckets ?? 0} 分钟桶`];
    // 支出是合并口径（本机 + 已读到的他机），不是这台机器自己花的——写「本机」会看错人
    if (spend) parts.push(`7 天合计 $${(spend.spentUSD ?? 0).toFixed(2)}`);
    parts.push(p.speed?.rows?.length ? `速度 ${p.speed.rows.length} 种模型` : '速度无样本');
    parts.push(sy ? `同步 ${sy.state}${sy.error ? ' · ' + sy.error : ''} · 在场 ${sy.machines?.length ?? 0} 台`
      : '同步未配置（写 ~/.miraquota/sync.json）');
    return parts.join(' · ');
  };
  // 这台机器没人盯屏，日志只在现状变了时才写一行——journal 里留下的是事件，不是心跳噪音。
  let last = '';
  const tick = () => {
    const s = line();
    if (s !== last) { last = s; log(s); }
  };
  await engine.poll();
  tick();
  // hub 通道跟桌面同频（15 秒）：分片要「有新动静就早发」，而早发的机会只在 poll 里，
  // 60 秒一轮就意味着别人最多晚一分钟才看得到这台机器刚跑完的请求。账本是增量扫的，
  // 15 秒一次在服务器上不值一提。git / 收件口仍走 60 秒——那两条的发布本身就贵。
  const pollMs = engine.sync?.mode === 'hub' ? POLL_MS : SYNC_ONLY_POLL_MS;
  const timer = setInterval(() => engine.poll().then(tick).catch(() => {}), pollMs);
  const bye = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
} else {

const { server, port: feedPort } = await startFeed({
  payload: () => engine.payload(),
  onQuit: () => shutdown(0),
  explicitPort: Number(opt('feed-port', 0)),
});
log(`feed http://127.0.0.1:${feedPort}/quota.json`);

const injector = new Injector({
  widgetPath: opt('widget', join(HERE, '..', 'widget', 'miraquota-widget.js')),
  cdpPorts: CDP_PORTS,
  log,
});
if (injector.hasWidget) log(`控件 v${injector.version} ${injector.widgetPath}`);

await engine.poll();
printSnapshot(engine.payload());
const pollTimer = setInterval(() => engine.poll().catch(() => {}), POLL_MS);
if (!flag('no-inject')) injector.start(feedPort);

function shutdown(code) {
  clearInterval(pollTimer);
  injector.stop();
  server.close();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

}
