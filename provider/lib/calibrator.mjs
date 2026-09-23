/**
 * 满额自校准。移植自 Swift 版 Calibrator.swift（点数口径）。
 *
 * 原始额度点与 API 等价支出在观测窗口内呈线性关系，故满额可由
 * 「一段时间的支出 ÷ 同期点数增量 × 预算点」反推。Windows 上 /v1/limits 可读，
 * 主走点数口径：`used` 是绝对量、跨预算点变更可比，优于 relay 帧的百分比口径。
 *
 * 支出与增量两侧都会挂起到对面也非零时才成为一次观测：只挂起支出会低估满额，
 * 只挂起增量会高估（有请求在途时增量先涨、美元后落）。
 *
 * 抗他机污染（点数是账号级、账本是本机级，另一台机器同时在用会把观测单价拉低）：
 * 1. 挂起的点数增量超时仍等不到本机支出 ⇒ 判定该时段他机活跃，前后 FOREIGN_PAD
 *    内的观测一并剔除（对面在跑，相邻分钟大概率也在跑）；
 * 2. 聚合用「按点数加权的隐含单价中位数」而非 Σ$/Σ点：污染样本单价系统性偏低、
 *    堆在一侧，中位数最多容忍近半污染。
 *
 * 多机账本同步（docs/MULTI-MACHINE.md）启用后，账本支出已是全机合并口径：
 * 一段观测只有当在场每台外机分片的 coverage 都盖住它时才算「全覆盖」，此时分子
 * 已含他机支出，不再被上面第 1 条误伤；不全覆盖的时段沿用第 1 条兜底剔除。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { modelGroup } from './windows.mjs';

const STATE_DIR = join(homedir(), '.miraquota');
const STATE_FILE = join(STATE_DIR, 'calibration.json');

const POINT_RETENTION = 3 * 86400;    // 点数样本保留时长
const MAX_POINT_SAMPLES = 12000;
const POINT_MIN_INTERVAL = 30;        // 两条点数样本的最小间隔（秒）
const CARRY_TIMEOUT = 600;            // 挂起增量等待支出的上限（秒）
const FOREIGN_PAD = 300;              // 他机活跃段向两侧扩散剔除的半径（秒）

const CONFIDENCE = { none: 0, low: 1, medium: 2, high: 3 };
const CONFIDENCE_LABEL = { none: '无样本', low: '标定中', medium: '收敛中', high: '高置信' };

export class Calibrator {
  /** @param stateFile 状态文件路径（测试注入用，默认 ~/.miraquota/calibration.json） */
  constructor(stateFile = STATE_FILE) {
    this.stateFile = stateFile;
    this.points = {};   // label → [{ at, used, budget, resetAt }]
    // 与点数读数同一瞬间的「各模型美元增量」：[{ at, d: { 模型: 美元 } }]，`gap` 为真表示
    // 累计基准断了（重启、修剪过老桶），跨它的区间不能用。倍率测算只认这个配对——
    // 分子分母同一个时间窗才谈得上准（见 rate-measure.mjs）。
    this.marks = [];
    this.lastTotals = null;   // 上一 tick 的累计（只在内存，重启即断，落一个 gap）
    this.#load();
  }

  #load() {
    try {
      const p = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      this.points = p.points ?? {};
      this.marks = Array.isArray(p.marks) ? p.marks : [];
    } catch { /* 首次运行 */ }
  }

  #save() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({ points: this.points, marks: this.marks }));
    } catch { /* ignore */ }
  }

  /**
   * 记录一次原始点数观测。未到间隔或值未变时不追加。
   *
   * **点数样本只记在有 mark 的那些 tick 上**（`#mark` 返回假就整轮不记）。倍率测算要拿
   * 「同一个 tick 上的点数」配「同一个 tick 上的美元」，而 mark 的间隔门与点数的间隔门
   * 原先各自独立：某款模型值没变的那一轮会记下 mark 却不记点数，于是下一个点数样本落在
   * 「上一个 mark 之后」而不是「某个 mark 上」，一段的美元就凑不齐（少算或把上一段算进来）。
   * 让 mark 当节拍器后，每个点数样本都踩在 mark 上，段内把 mark 增量累加即恰好等于
   * (a.at, b.at] 的花费（见 rate-measure.mjs）。代价只是点数样本对齐到 mark 节拍，
   * 间隔仍是 30 秒，粒度不变。
   *
   * @param byModel 这一刻各模型的累计美元（`ledger.cumulativeByModel()`）。给了就同时记一条
   *   增量 mark；不给则记一个 gap——没有配对的美元，这一段就不该被倍率测算用上。
   */
  record(windows, capturedSec, byModel = null) {
    if (!this.#mark(capturedSec, byModel)) return;
    let dirty = false;
    for (const w of windows) {
      if (!(w.budget > 0)) continue;
      const list = this.points[w.label] ?? (this.points[w.label] = []);
      const last = list[list.length - 1];
      if (last) {
        if (capturedSec - last.at < POINT_MIN_INTERVAL) continue;
        if (last.used === w.used && last.budget === w.budget && last.resetAt === w.resetAt) continue;
      }
      list.push({ at: capturedSec, used: w.used, budget: w.budget, resetAt: w.resetAt });
      dirty = true;
    }
    if (dirty || this.marks.length) { this.#prune(); this.#save(); }
  }

  /**
   * 记一条与点数读数同瞬的美元增量，返回这一刻是否落了 mark（点数样本跟着它走）。
   * 累计值回落（修剪）或基准缺失时落 gap。
   */
  #mark(capturedSec, byModel) {
    const last = this.marks[this.marks.length - 1];
    if (last && capturedSec - last.at < POINT_MIN_INTERVAL) return false;
    if (!byModel) { this.lastTotals = null; this.marks.push({ at: capturedSec, gap: true }); return true; }
    const prior = this.lastTotals;
    this.lastTotals = { ...byModel };
    if (!prior) { this.marks.push({ at: capturedSec, gap: true }); return true; }
    const d = {};
    for (const [model, total] of Object.entries(byModel)) {
      const delta = total - (prior[model] ?? 0);
      if (delta !== 0) d[model] = delta;
    }
    // 少了模型 = 那个模型的桶被修剪掉了，基准不可比，整条标记为 gap
    const shrank = Object.keys(prior).some((m) => byModel[m] == null);
    this.marks.push(shrank ? { at: capturedSec, gap: true } : { at: capturedSec, d });
    return true;
  }

  #prune() {
    const cutoff = Date.now() / 1000 - POINT_RETENTION;
    for (const k of Object.keys(this.points)) {
      let kept = this.points[k].filter((s) => s.at >= cutoff);
      if (kept.length > MAX_POINT_SAMPLES) kept = kept.slice(kept.length - MAX_POINT_SAMPLES);
      this.points[k] = kept;
    }
    this.marks = this.marks.filter((m) => m.at >= cutoff).slice(-MAX_POINT_SAMPLES);
  }

  /**
   * 满额估计。`budget` 取自当帧（上游改档后旧样本的预算点即失效，必须乘当前值）；
   * `group` 给定时只计该模型档位组的支出，用于 modelScoped 窗口。
   * 返回 { fullUSD, confidence, observations, coveredPercent } 或 null。
   */
  estimate(label, ledger, budget = null, group = null, groupCost = {}) {
    const samples = this.points[label] ?? [];
    const useBudget = budget ?? samples[samples.length - 1]?.budget;
    if (samples.length < 2 || !(useBudget > 0)) return null;

    const { obs, dropped } = this.#observe(samples, ledger, group, groupCost);
    if (!obs.length) return null;
    const price = weightedMedianPrice(obs);
    if (!(price > 0)) return null;

    const totalUnit = obs.reduce((s, o) => s + o.unit, 0);
    const covered = totalUnit / useBudget * 100;
    return {
      fullUSD: price * useBudget,
      confidence: confidenceOf(obs.length, covered),
      observations: obs.length,
      coveredPercent: covered,
      foreignDropped: dropped,
    };
  }

  /**
   * 逐对配对出 (cost, unit, from, to) 观测。两侧挂起，窗口滚动或回落即清挂起。
   * 挂起增量超时 ⇒ 记一段他机活跃，与其（含 FOREIGN_PAD 扩散）相交的观测剔除；
   * 多机同步在场时，被全部外机分片覆盖的观测豁免剔除（分子已含他机支出）。
   */
  #observe(samples, ledger, group, groupCost = {}) {
    const obs = [];
    const foreign = [];   // 他机活跃时段 [from, to]
    // 总窗（group=null）的每段支出要按档位倍率折算，否则同一份 fable 用量在
    // 回归标定与兜底反推两条路上口径不一，界面会给出两个互相矛盾的满额。
    // 档位窗自己（group 非空）不折算：它的点数本就是该档位的计数，除出来即该档位单价。
    const costOf = (from, to) => {
      const base = ledger.spent(from, to, { group });
      if (group) return base;
      let usd = base;
      for (const [g, ratio] of Object.entries(groupCost)) {
        if (!(ratio > 0) || ratio === 1) continue;
        const part = ledger.spent(from, to, { group: g });
        if (part > 0) usd += (ratio - 1) * part;
      }
      return usd;
    };
    let pendingCost = 0, pendingUnit = 0, unitSince = null, spanStart = null;
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = samples[i], b = samples[i + 1];
      if (b.resetAt !== a.resetAt || b.used < a.used) {
        pendingCost = 0; pendingUnit = 0; unitSince = null; spanStart = null; continue;
      }
      const cost = costOf(a.at, b.at);
      if (unitSince != null && b.at - unitSince > CARRY_TIMEOUT) {
        foreign.push([unitSince, b.at]);
        pendingUnit = 0; unitSince = null;
      }
      if (spanStart == null && (cost > 0 || b.used > a.used)) spanStart = a.at;
      pendingCost += cost;
      pendingUnit += b.used - a.used;
      if (pendingCost > 0 && pendingUnit > 0) {
        obs.push({ cost: pendingCost, unit: pendingUnit, from: spanStart ?? a.at, to: b.at });
        pendingCost = 0; pendingUnit = 0; unitSince = null; spanStart = null;
      } else if (pendingUnit > 0 && unitSince == null) {
        unitSince = b.at;
      }
    }
    // 覆盖门：在场每台外机分片（未过期）都盖住 [from,to] 的观测才算全覆盖。
    // 全覆盖 ⇒ 合并口径的支出已含他机，剔除反而丢真样本；不全覆盖 ⇒ 沿用剔除兜底。
    const coverage = typeof ledger.foreignCoverage === 'function' ? ledger.foreignCoverage() : [];
    const covered = (o) => coverage.length > 0
      && coverage.every((c) => c.fromSec <= o.from && c.toSec >= o.to);
    const kept = foreign.length
      ? obs.filter((o) => covered(o)
        || !foreign.some(([f, t]) => o.to >= f - FOREIGN_PAD && o.from <= t + FOREIGN_PAD))
      : obs;
    return { obs: kept, dropped: obs.length - kept.length };
  }

  pointSampleCount(label) { return (this.points[label] ?? []).length; }

  /**
   * sinceSec 以来该窗口实际消耗的点数：逐对正增量求和（跨重置的回落不计）。
   * 停机期的消耗由停机前后两条样本的差值一次性补上（resetAt 未变时）。
   */
  consumedPoints(label, sinceSec) {
    const samples = (this.points[label] ?? []).filter((s) => s.at >= sinceSec);
    let sum = 0;
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = samples[i], b = samples[i + 1];
      if (b.resetAt === a.resetAt && b.used > a.used) sum += b.used - a.used;
    }
    return sum;
  }
}

/** 按点数加权的隐含单价中位数：污染/畸变样本堆在一侧，中位数最多容忍近半污染。 */
function weightedMedianPrice(obs) {
  const sorted = [...obs].sort((a, b) => a.cost / a.unit - b.cost / b.unit);
  const half = sorted.reduce((s, o) => s + o.unit, 0) / 2;
  let acc = 0;
  for (const o of sorted) {
    acc += o.unit;
    if (acc >= half) return o.cost / o.unit;
  }
  return null;
}

function confidenceOf(observations, covered) {
  if (covered >= 20 && observations >= 15) return 'high';
  if (covered >= 5 && observations >= 5) return 'medium';
  return 'low';
}

export { CONFIDENCE, CONFIDENCE_LABEL };
