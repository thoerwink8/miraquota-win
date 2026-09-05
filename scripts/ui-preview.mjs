#!/usr/bin/env node
/**
 * 面板界面的浏览器预览：把 app/renderer/index.html 连同一份假 payload 生成到临时文件，
 * 用普通浏览器打开就能看界面——桌面版是单实例锁，装好的应用在跑时起不了第二个实例，
 * 改完 UI 没法立刻看见（2026-09-05 踩到）。
 *
 *   node scripts/ui-preview.mjs [--out <路径>] [--payload <json 文件>]
 *
 * 默认那份假 payload 覆盖「两台机器 + 他机带速度」的形态，专门用来看机器切换条。
 * 只读不写业务状态，跟真数据无关。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const OUT = opt('out', join(tmpdir(), 'miraquota-ui-preview.html'));

const now = Math.floor(Date.now() / 1000);
const speedRow = (model, rate, ttft, at) => ({
  model, modelId: model, familyId: 'claude', familyLabel: 'Claude',
  samples: 5, rate, ttft, endToEnd: rate * 0.6, latestAt: at, measured: false,
  tasks: [1, 2, 3].map((i) => ({ id: 'task' + i, at: at - i * 300, durationMs: 12_000 + i * 1000, outputTokens: 900, rate: rate - i })),
});

const payload = JSON.parse(opt('payload') ? readFileSync(opt('payload'), 'utf8') : JSON.stringify({
  stateLabel: '在线', measured: true, buckets: 4210, pricing: 'builtin(official)',
  unitPriceUSD: 0.01, windows: [
    { label: '5h', usedPercent: 7.5, spentUSD: 124.9, fullUSD: 1719, confidence: 'high', sampleCount: 12,
      resetAt: now + 5700, durationSeconds: 18_000, remainingUSD: 1589,
      points: { used: 12_928, budget: 172_000 }, families: [] },
    { label: '7d', usedPercent: 78.5, spentUSD: 3143.5, fullUSD: 6138, confidence: 'high', sampleCount: 40,
      resetAt: now + 216_000, durationSeconds: 604_800, remainingUSD: 1321,
      points: { used: 481_620, budget: 614_000 }, families: [] },
  ],
  speed: { rows: [speedRow('Opus 5', 36, 2.4, now - 360), speedRow('Haiku 4.5', 70, 1.1, now - 3600)], sampleTotal: 24, inflightSince: [] },
  sync: {
    state: 'ok', mode: 'git', pushOk: true, intervalSec: 600, lastSyncSec: now - 120,
    machines: [
      { id: 'desktop-get3dbc', key: 'aaaa1111', account: null, lastShardSec: now - 120, self: true },
      { id: 'vmi3551059', key: 'bbbb2222', account: null, lastShardSec: now - 240, self: false,
        speed: { rows: [speedRow('Opus 5', 62, 1.6, now - 200), speedRow('gpt-5.6-sol', 10, 3.0, now - 900)], sampleTotal: 9 } },
    ],
    usage: {
      label: '7d', officialPoints: 481_620, unattributedPoints: 12_000, unattributedUSD: 120,
      machines: [
        { id: 'desktop-get3dbc', key: 'aaaa1111', self: true, usd: 2974.2, points: 297_420 },
        { id: 'vmi3551059', key: 'bbbb2222', self: false, usd: 1720, points: 172_000 },
      ],
    },
  },
}));

const stub = `<script>
  // 假桥：只喂一份固定 payload，够界面把所有分支画出来
  const PAYLOAD = ${JSON.stringify(payload)};
  window.miraquota = {
    get: () => Promise.resolve(PAYLOAD),
    version: () => Promise.resolve('preview'),
    getTheme: () => Promise.resolve('system'),
    setTheme: () => Promise.resolve('system'),
    onQuota: () => {},
    update: () => Promise.resolve(null),
    onUpdate: () => {},
    promptUpdate: () => Promise.resolve(),
    checkUpdate: () => Promise.resolve(),
    setPointCost: () => Promise.resolve(true),
    syncLogin: () => Promise.resolve({ ok: false, error: '预览模式' }),
    minimize: () => {}, hide: () => {}, quit: () => {},
  };
</script>`;

const html = readFileSync(join(ROOT, 'app', 'renderer', 'index.html'), 'utf8').replace('</head>', stub + '\n</head>');
writeFileSync(OUT, html);
console.log(OUT);
