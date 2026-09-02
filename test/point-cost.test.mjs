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

test('every window reports the total-ratio full value, median only as fallback', () => {
  // 2026-09-02 用户拍板：满额改用「整窗支出 ÷ 整窗点数 × 预算点」，与官方 5600 对得上。
  // 总窗乘折算后的基准单价；档位窗用它自己的支出与点数（它的点已按倍率扣过，不再折算）。
  const src = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  // 面板上每个数都由同一个模型推出来：总窗 = 基准单价 × 预算点，档位窗 = 基准单价 ÷ 倍率
  // × 预算点。用户 2026-09-02 指出：档位窗若走自己的实测比值，改设置时它不动，看着像 bug。
  assert.ok(src.includes("? (rate != null && groupRatio > 0 ? rate / groupRatio * w.budget"),
    '档位窗满额要跟着设置的倍率走');
  assert.ok(src.includes(": (rate != null ? rate * w.budget : null)"), '总窗要乘折算后的基准单价');
  assert.ok(src.includes("(spent > 0 && w.used > 0 ? spent / w.used * w.budget : null))"),
    '基准单价给不出时才退回该档位自己的实测比值');
  assert.ok(src.includes("fullUSD: ratioFull, basis: 'ratio'"), '总额比值优先');
  assert.ok(src.includes("fullUSD: est.fullUSD, basis: 'median'"), '给不出时才退回中位数');
  assert.match(src, /conservativeUSD/);
});

test('a ratio that contradicts the measured one is called out on the scoped card', () => {
  // 用户把 fable 倍率改成 1 后问「fable 满额怎么没变」——不是没生效：档位卡的满额是
  // 实测口径（该档位自己的支出 ÷ 自己的点数），设置只改总窗。两者矛盾时必须说出来，
  // 否则用户只看到两个对不上的数，不知道是自己的设置与事实不符。
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  assert.match(renderer, /设置 \$\{cost\.ratio\}× 与实测/);
  assert.ok(renderer.includes('Math.abs(cost.measured - cost.ratio) / cost.measured > 0.15'),
    '偏差超过 15% 才提示，免得实测噪声天天报警');
});

test('the ratio setting stays visible when Mirasim is not running', () => {
  // 用户 2026-09-02 报「最近没使用就不展示 fable 倍率」——真实原因不是用量：pointCost
  // 只在实测路径生成，Mirasim 一停就整个字段消失，界面把整张配置卡都藏了。设置是设置，
  // 连不连得上都该看得见、改得动；实测值给不出时要说清是没连上还是样本薄。
  const src = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('#pointCost(windows, atSec)'), '三条路径共用一个 pointCost 生成器');
  assert.ok(src.includes("this.#pointCost(this.anchors.anchors, this.anchors.capturedAt)"),
    '推算路径用锚点采集时刻算实测——拿陈旧点数配当下账本会算出假倍率');
  assert.ok(src.includes('this.#pointCost(this.anchors.anchors, null)'),
    '本机路径没有官方点数，只回设置值');
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  assert.ok(renderer.includes("latest?.measured === false"), '要分开「没连上」和「样本不够」');
  assert.match(renderer, /Mirasim 未运行，实测倍率暂不可给/);
});

test('each window shows the ratio-weighted spend next to the raw ledger spend', () => {
  // 用户 2026-09-02：「7d 统计口径要结合 fable 额外倍数，把真实倍率后的花费算进去」。
  // 主行仍是账本原值（真实花费，可与 Mirasim 逐笔核对），但它与满额不同口径：满额是点数
  // 口径。少了折算值，$426 比 $5580 会被读成 7.6%，而官方计数器写着 11.6%。
  const src = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('weightedSpentUSD: weighted'), '窗口要带折算后支出');
  assert.ok(src.includes('weightedSpend(this.ledger, start, now, this.settings.groupPointCost).usd'),
    '总窗折算走同一个 weightedSpend，与单价、满额同源');
  assert.ok(src.includes('spent * (this.settings.ratioOf(group) || 1)'), '档位窗按自己的倍率折算');
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  assert.ok(renderer.includes('w.weightedSpentUSD != null'));
  assert.match(renderer, /折算 <b>/);
});

test('the panel cross-checks the reverse-inferred price against the official 1/100 anchor', () => {
  // 官方三个窗口的点数都恰好整除 100：560000→5600、156800→1568、296800→2968。
  // 本机反推 ≈0.0100 与之吻合，这是「5600 到底对不对」的直接证据。仍然反推而不是写死——
  // 写死 0.01 会让账本漏计/超算再也无法被发现（反推与官方的偏离就是那道检查）。
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  assert.ok(renderer.includes('const OFFICIAL_PER_POINT = 0.01;'));
  assert.match(renderer, /点数 ÷ 100 = 美元/);
  assert.match(renderer, /本机反推偏离/);
  const engine = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.ok(!engine.includes('0.01;'), '引擎里不许出现写死单价——美元一律由账本反推');
  for (const [pts, usd] of [[560000, 5600], [156800, 1568], [296800, 2968]]) {
    assert.equal(pts * 0.01, usd);
  }
});
