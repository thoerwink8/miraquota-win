/**
 * 档位点数倍率的契约测试（2026-09-02 用户拍板）。
 * 官方口径：fable 资源紧张，同一份用量按 2 倍扣点，所以「每点美元」必须先把 fable 支出
 * 按倍率放大再除总点数，得到的才是**非 fable 的基准单价**，与官方「不用 fable 时 5600」同口径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Settings, DEFAULT_GROUP_POINT_COST } from '../provider/lib/settings.mjs';
import { evaluateCoherence, weightedSpend, measureGroupRatio } from '../provider/lib/coherence.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-cost-'));
const settingsAt = (name) => new Settings(join(tmp, `${name}.json`));

/** 账本替身：spent(from,to,{group}) 按组返回定值，够核算用。 */
const fakeLedger = ({ total, byGroup = {} }) => ({
  spent: (_f, _t, opts = {}) => (opts.group ? (byGroup[opts.group] ?? 0) : total),
});

const now = 1_800_000_000;
const windows7d = [
  { label: '7d', used: 42928, budget: 560000, resetAt: now + 86400, modelScoped: false },
  { label: '7d_fable', used: 28520, budget: 296800, resetAt: now + 86400, modelScoped: true },
];

test('the default fable ratio is the official 2x', () => {
  assert.equal(DEFAULT_GROUP_POINT_COST.fable, 2);
  assert.equal(settingsAt('fresh').ratioOf('fable'), 2);
  assert.equal(settingsAt('fresh').ratioOf('opus'), 1);   // 没配过的组不该被凭空加权
});

test('a changed ratio survives a restart and rejects nonsense', () => {
  const s = settingsAt('persist');
  assert.equal(s.setGroupRatio('fable', 1.5), true);
  assert.equal(new Settings(s.file).ratioOf('fable'), 1.5, '重开应读到 1.5，而不是回默认 2');
  for (const bad of [0, -1, 'x', 99, null, undefined]) {
    assert.equal(s.setGroupRatio('fable', bad), false, `${bad} 不该被接受`);
  }
  assert.equal(new Settings(s.file).ratioOf('fable'), 1.5, '非法值不许改坏已存的配置');
});

test('a broken settings file falls back to defaults instead of breaking the engine', () => {
  const file = join(tmp, 'broken.json');
  writeFileSync(file, '{ not json');
  assert.equal(new Settings(file).ratioOf('fable'), 2);
});

test('fable spend is scaled by the ratio before dividing by points', () => {
  // 本机实测量级：7d 账本 $190.87，其中 fable $86.50；点数 42928
  const ledger = fakeLedger({ total: 190.87, byGroup: { fable: 86.50 } });
  const raw = evaluateCoherence(windows7d, ledger, now, {});
  const adj = evaluateCoherence(windows7d, ledger, now, { fable: 2 });
  assert.ok(Math.abs(raw.perPoint - 190.87 / 42928) < 1e-9);
  assert.ok(Math.abs(adj.perPoint - (190.87 + 86.50) / 42928) < 1e-9);
  // 折算后满池 ≈ $3618，不折算只有 ≈ $2490——差的就是官方说的「fable 用得越多，折算美元越少」
  assert.ok(adj.perPoint * 560000 > 3500 && adj.perPoint * 560000 < 3700);
  assert.ok(raw.perPoint * 560000 < 2600);
  // 折算明细要能交代来源，否则用户拿这个数对账本永远对不上
  assert.deepEqual(adj.basis.adjustments, [{ group: 'fable', ratio: 2, usd: 86.50 }]);
  assert.ok(Math.abs(adj.basis.rawUSD - 190.87) < 1e-9);
});

test('ratio 1 leaves every number exactly as before', () => {
  const ledger = fakeLedger({ total: 100, byGroup: { fable: 40 } });
  assert.deepEqual(weightedSpend(ledger, 0, now, { fable: 1 }), { usd: 100, raw: 100, adjustments: [] });
  assert.deepEqual(weightedSpend(ledger, 0, now, {}), { usd: 100, raw: 100, adjustments: [] });
});

test('the measured ratio comes from two independent official counters', () => {
  const ledger = fakeLedger({ total: 190.87, byGroup: { fable: 86.50 } });
  const m = measureGroupRatio(windows7d, ledger, now, 'fable');
  // fable 单价 = 86.50/28520；非 fable 单价 = 104.37/14408；比值 ≈ 2.39（本机实测值）
  assert.ok(Math.abs(m.measured - 2.39) < 0.02, `实测倍率应 ≈2.39，得到 ${m.measured}`);
  // 样本不足时宁可不给，也不给噪声算出来的倍率
  assert.equal(measureGroupRatio([
    { label: '7d', used: 300, budget: 560000, resetAt: now + 1, modelScoped: false },
    { label: '7d_fable', used: 250, budget: 296800, resetAt: now + 1, modelScoped: true },
  ], ledger, now, 'fable'), null);
});

test('the config lives on the spec tab, not the first screen', () => {
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  assert.match(renderer, /<div class="page" id="pageSpec">\s*<div class="card" id="cfgCard"/);
  assert.doesNotMatch(renderer.split('id="pageSim"')[0], /id="fableRatio"/);   // 总览页不出现
  assert.match(renderer, /setPointCost\?\.\('fable'/);
  assert.ok(existsSync(new URL('../provider/lib/settings.mjs', import.meta.url)));
});

test('the measured ratio pairs the scoped window with the pool window of the same length', () => {
  // 实测踩过：窗口表里 5h 排在 7d 前面，若取「第一个非档位窗」会拿 5h 池配 7d_fable，
  // 「非该档位点数」算成负数，倍率直接消失（界面上表现为一直显示样本不够）。
  const ledger = fakeLedger({ total: 290.79, byGroup: { fable: 141.93 } });
  // 合并多机账本后的实测量级：7d 43413 点（fable 28520）、账本 $290.79（fable $141.93）
  const merged7d = [
    { label: '7d', used: 43413, budget: 560000, resetAt: now + 86400, modelScoped: false },
    windows7d[1],
  ];
  const withFiveHour = [
    { label: '5h', used: 7500, budget: 156800, resetAt: now + 3600, modelScoped: false },
    ...merged7d,
  ];
  const m = measureGroupRatio(withFiveHour, ledger, now, 'fable');
  assert.ok(m, '有同长度的 7d 窗就必须算得出倍率');
  assert.ok(Math.abs(m.measured - 2.01) < 0.02, `合并多机账本后实测 ≈2.01×，得到 ${m?.measured}`);
  // 只有 5h 池、没有 7d 池时宁可不给
  assert.equal(measureGroupRatio([withFiveHour[0], merged7d[1]], ledger, now, 'fable'), null);
});

test('pool windows report the total-ratio full value, scoped windows keep the median', () => {
  // 2026-09-02 用户拍板：卡片满额改用「整窗支出 ÷ 整窗点数 × 预算点」，与官方 5600 对得上；
  // 中位数退居备用。档位窗不能乘基准单价（那是非该档位的价），仍走中位数。
  const src = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(rate != null && !group\) \{[\s\S]*?fullUSD: rate \* budget, basis: 'ratio'/);
  assert.match(src, /fullUSDBasis: basis/);
});
