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
import { evaluateCoherence, weightedSpend } from '../provider/lib/coherence.mjs';
import { measureModelRates, groupRate } from '../provider/lib/rate-measure.mjs';
import { Calibrator } from '../provider/lib/calibrator.mjs';

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

/**
 * 造一串点数样本与同瞬的美元增量。segs 每项 { spend: {模型: 美元}, points, gap }，
 * 一项就是相邻两次采样之间发生的事。
 */
const series = (segs, startAt = now) => {
  const samples = [{ at: startAt, used: 1000, budget: 296800, resetAt: startAt + 86400 }];
  const marks = [{ at: startAt, d: {} }];
  let at = startAt, used = 1000;
  for (const s of segs) {
    at += 30; used += s.points ?? 0;
    samples.push({ at, used, budget: 296800, resetAt: startAt + 86400 });
    marks.push(s.gap ? { at, gap: true } : { at, d: s.spend ?? {} });
  }
  return { samples, marks };
};

test('the measured ratio is the median of single-model segments, not a window division', () => {
  // 10 段干净的 fable：$1 花掉 200 点（官方基准 100 点/$ 的 2 倍）；再塞两段时间错位的
  // 脏数据——本机实测里确实会出现 40 点/$ 与 443 点/$ 这种段（账本与官方计数器差一个采样格）。
  const segs = Array.from({ length: 10 }, () => ({ spend: { 'claude-fable-5-1': 1 }, points: 200 }));
  segs.push({ spend: { 'claude-fable-5-1': 1 }, points: 40 });
  segs.push({ spend: { 'claude-fable-5-1': 1 }, points: 443 });
  const { samples, marks } = series(segs);
  const [fable] = measureModelRates(samples, marks);
  assert.equal(fable.model, 'claude-fable-5-1');
  assert.equal(fable.multiplier, 2, '中位数必须正好落在 2.00，错位段不许把它拖走');
  assert.equal(fable.segments, 12);
  // 同一批数据按「整窗总量相除」得 (10*200+40+443)/12/100 = 2.07，脏段一多就越偏
  const wholeWindow = segs.reduce((s, x) => s + x.points, 0) / segs.length / 100;
  assert.ok(Math.abs(wholeWindow - 2.0) > 0.02, '整窗相除本来就会偏，这条测的就是中位法更稳');
});

test('a segment with two models in it, or a gap in the dollar basis, is not measured', () => {
  const mixed = series([
    { spend: { 'claude-fable-5-1': 1, 'claude-opus-5': 1 }, points: 300 },   // 两个模型，分不清
    { spend: { 'claude-fable-5-1': 1 }, points: 999, gap: true },            // 美元基准断了
  ]);
  assert.deepEqual(measureModelRates(mixed.samples, mixed.marks), []);
  // 样本太少（少于 3 段、或累计支出不到 $2）时宁可不给，也不给一个噪声算出来的倍率
  const thin = series([{ spend: { 'claude-fable-5-1': 1 }, points: 200 }]);
  assert.deepEqual(measureModelRates(thin.samples, thin.marks), []);
});

test('fable-5 and fable-5-1 are measured apart, and a disagreement is visible', () => {
  const seg = (model, points) => ({ spend: { [model]: 1 }, points });
  const same = series([
    ...Array.from({ length: 4 }, () => seg('claude-fable-5-1', 200)),
    ...Array.from({ length: 4 }, () => seg('claude-fable-5', 200)),
  ]);
  const rates = measureModelRates(same.samples, same.marks);
  assert.deepEqual(rates.map((r) => r.model).sort(), ['claude-fable-5', 'claude-fable-5-1']);
  const g = groupRate(rates, 'fable');
  assert.equal(g.multiplier, 2);
  assert.equal(g.agree, true, '两个版本量出同一个倍率时，组值才代表得了它们');

  const split = series([
    ...Array.from({ length: 4 }, () => seg('claude-fable-5-1', 200)),
    ...Array.from({ length: 4 }, () => seg('claude-fable-5', 100)),
  ]);
  const g2 = groupRate(measureModelRates(split.samples, split.marks), 'fable');
  assert.equal(g2.agree, false, '版本之间不一致必须能看出来——那个「一组一倍率」的配置就是个混合值');
  assert.equal(g2.members.length, 2);
});

test('a segment sums every mark inside it, not just the one on the closing sample', () => {
  // mark 是增量，点数样本的间隔门与 mark 的间隔门各自独立：某款模型值没变的那一轮只记
  // mark 不记点数。于是 (a, b] 里能有好几条 mark，只取 b 那一条会把这一段算成 5×——
  // 这正是「倍率一直算不准」里最难看见的一处（它只在样本恰好错过 mark 节拍时出现）。
  const samples = [];
  const marks = [];
  let used = 1000;
  for (let k = 0; k < 4; k++) {
    const t0 = now + 90 * k;
    samples.push({ at: t0, used, budget: 296800, resetAt: now + 86400 });
    marks.push({ at: t0, d: {} });
    marks.push({ at: t0 + 30, d: { 'claude-fable-5-1': 0.6 } });   // 这一轮点数没变，只有 mark
    used += 200;
    samples.push({ at: t0 + 60, used, budget: 296800, resetAt: now + 86400 });
    marks.push({ at: t0 + 60, d: { 'claude-fable-5-1': 0.4 } });
  }
  const [fable] = measureModelRates(samples, marks);
  assert.equal(fable.segments, 4);
  assert.equal(fable.multiplier, 2, '200 点 ÷ ($0.6 + $0.4) ÷ 100 = 2.00，不是 200÷0.4÷100');
  assert.equal(fable.p25, 2);
  assert.equal(fable.p75, 2);

  // 反过来：样本没踩在 mark 上（改这版之前存下的点数样本）就不该拿它算——求和会从
  // a.at 之前那一条 mark 起算，把上一段的钱算进这一段。宁可不给。
  const legacy = measureModelRates([{ ...samples[0], at: now + 5 }, ...samples.slice(1)], marks);
  assert.equal(legacy[0].segments, 3, '端点不在 mark 节拍上的那一段必须丢掉，而不是算成 5×');
});

test('point samples only land on mark ticks, so every segment has dollars at both ends', () => {
  // 这是上面那条求和规则的前提，也是它唯一容易被破坏的地方：只要有一轮记了点数却没记
  // mark，那个样本就成了「端点不在节拍上」的段，被整段丢掉——数据看着在，倍率却一直
  // 样本不足。所以钉住：没落 mark 的那一轮，点数也不许落。
  const cal = new Calibrator(join(tmp, 'cal-marks.json'));
  const w = (used) => [{ label: '7d_fable', used, budget: 296800, resetAt: now + 86400, modelScoped: true }];
  cal.record(w(1000), now, {});                                  // 首次：基准缺失，落 gap
  cal.record(w(1200), now + 5, {});                              // 未到 30 秒：整轮都不记
  cal.record(w(1200), now + 40, { 'claude-fable-5-1': 0.5 });    // 点数没变，mark 照记
  cal.record(w(1400), now + 70, { 'claude-fable-5-1': 1.5 });
  const ats = cal.points['7d_fable'].map((p) => p.at);
  const markAts = new Set(cal.marks.map((m) => m.at));
  assert.deepEqual(ats, [now, now + 40, now + 70], '未到间隔的那一轮不许留下点数样本');
  for (const at of ats) assert.ok(markAts.has(at), `${at} 这个点数样本没有同瞬的 mark`);
  // 相邻两点数样本之间的 mark 之和就是这一段的美元：(now,now+40] = $0.5、(now+40,now+70] = $1.0
  const between = cal.marks.filter((m) => m.at > now && m.at <= now + 40);
  assert.equal(between.reduce((s, m) => s + (m.d?.['claude-fable-5-1'] ?? 0), 0), 0.5);
});

test('the config lives on the spec tab, not the first screen', () => {
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  assert.match(renderer, /<div class="page" id="pageSpec">\s*<div class="card" id="cfgCard"/);
  assert.doesNotMatch(renderer.split('id="pageSim"')[0], /id="fableRatio"/);   // 总览页不出现
  assert.match(renderer, /setPointCost\?\.\('fable'/);
  assert.ok(existsSync(new URL('../provider/lib/settings.mjs', import.meta.url)));
});

test('the measured ratio reads the scoped window, so other models cannot pollute it', () => {
  // 档位窗（7d_fable）的点数只数 fable 自己的模型，是量它倍率最干净的计数器。
  // 引擎按 modelGroup(label) 找这个窗，找不到才退到总窗——这条订住那个选择。
  const src = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.match(src, /w\.modelScoped && modelGroup\(w\.label\) === g/);
  assert.match(src, /measureModelRates\(this\.calibrator\.points\[label\], this\.calibrator\.marks\)/);
  // 美元与点数必须在同一个 tick 上取——分子分母不同时刻就是上一版算不准的根
  assert.match(src, /this\.calibrator\.record\(limits\.windows, atSec, this\.ledger\.cumulativeByModel\(\)\)/);
});

test('full quota comes from the official points/100 rule on every payload path', () => {
  // 2026-09-02 用户向官方求证：额度点 ÷ 100 = 美元额度。此前靠账本反推，两处硬伤——
  // 账本漏一点满额同倍缩水（实测 -3.5%），且 Mirasim 一停就退到另一套中位数算法
  // （用户截图里 7d 报 $2837 而非 $5600）。现在三条路径同一个数，且不依赖账本。
  const src = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('export const OFFICIAL_PER_POINT = 0.01;'), '官方汇率是常量，不再反推');
  assert.ok(src.includes('return budget * OFFICIAL_PER_POINT / ratio;'), '档位窗要除倍率');
  // 实测路径与推算路径都必须走同一个 #officialFull——分家就是上次那个 bug
  assert.equal((src.match(/#officialFull\(/g) ?? []).length, 3, '定义 1 处 + 两条路径各调 1 次');
  assert.ok(src.includes("fullUSD: ratioFull, basis: 'official'"));
  assert.ok(src.includes("fullUSD: est.fullUSD, basis: 'median'"), '纯本机口径没有预算点，才退中位数');
  for (const [pts, usd] of [[560000, 5600], [156800, 1568], [296800, 2968]]) {
    assert.equal(pts * 0.01, usd, '官方三个窗口的点数都整除 100');
  }
  assert.equal(296800 * 0.01 / 2, 1484, 'fable 子上限真能花掉的 API 用量');
});

test('a ratio that contradicts the measured one is called out on the scoped card', () => {
  // 用户把 fable 倍率改成 1 后问「fable 满额怎么没变」——不是没生效：档位卡的满额是
  // 实测口径（该档位自己的支出 ÷ 自己的点数），设置只改总窗。两者矛盾时必须说出来，
  // 否则用户只看到两个对不上的数，不知道是自己的设置与事实不符。
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  assert.match(renderer, /设置 \$\{cost\.ratio\}× ≠ 实测/);
  assert.ok(renderer.includes('Math.abs(cost.measured - cost.ratio) / cost.measured > 0.15'),
    '偏差超过 15% 才提示，免得实测噪声天天报警');
});

test('the ratio setting stays visible when Mirasim is not running', () => {
  // 用户 2026-09-02 报「最近没使用就不展示 fable 倍率」——真实原因不是用量：pointCost
  // 只在实测路径生成，Mirasim 一停就整个字段消失，界面把整张配置卡都藏了。设置是设置，
  // 连不连得上都该看得见、改得动；实测值给不出时要说清是没连上还是样本薄。
  const src = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('#pointCost(windows) {'), '三条路径共用一个 pointCost 生成器');
  // 实测值现在来自存下来的采样段（美元与点数同瞬记录），不再需要「这一刻」的时间戳——
  // 于是推算态、纯本机态也照样给得出实测倍率，不是只有连着 Mirasim 时才有
  assert.equal((src.match(/this\.#pointCost\(/g) ?? []).length, 3, '三条 payload 路径各调一次');
  assert.ok(!src.includes('#pointCost(windows, atSec)'), '别再把实测值绑在某一刻的账本上');
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

test('the reverse-inferred price survives as a ledger health check, not as the basis', () => {
  // 反推不删：它与官方 0.01 的偏离＝本机账本漏了多少（未归因点数、relay 未回填、
  // 他机分片延迟）。删掉它，账本再漏也没人报警——但它不能再当满额的地基。
  const engine = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.ok(engine.includes('out.unitPriceUSD = OFFICIAL_PER_POINT;'), '对外单价给官方值');
  assert.ok(engine.includes('out.ledgerPerPoint = rate;'), '反推值另开字段');
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  assert.match(renderer, /账本对表/);
  assert.ok(renderer.includes('p.ledgerPerPoint.toFixed(6)'));
  assert.ok(renderer.includes("if (dev < -2) t +="), '偏低要说清主行数字该往上看');
});

test('the ratio field says which unit it wants, so nobody types the per-token 4', () => {
  // 「fable 2 倍」和「fable 4 倍」都对，看单位：每美元 2 倍（官方说法，也是这个设置的口径），
  // 每 token 4 倍（fable 标价 $10/$50 本身就是 opus $5/$25 的两倍，之上再罚两倍）。
  // 填错一个字所有美元数翻倍，而且不会报错——只能靠这行字挡住。
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  const card = renderer.split('id="cfgCard"')[1].split('</div>\n      </div>')[0];
  assert.match(card, /每美元/);
  assert.match(card, /每 token/);
  assert.match(card, /4 倍/);
  assert.ok(card.includes('填 2'), '要直说填哪个数，不能只讲道理');
});
