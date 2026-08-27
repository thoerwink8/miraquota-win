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
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  constructor() {
    this.points = {};   // label → [{ at, used, budget, resetAt }]
    this.#load();
  }

  #load() {
    try { this.points = JSON.parse(readFileSync(STATE_FILE, 'utf8')).points ?? {}; }
    catch { /* 首次运行 */ }
  }

  #save() {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify({ points: this.points }));
    } catch { /* ignore */ }
  }

  /** 记录一次原始点数观测。未到间隔或值未变时不追加。 */
  record(windows, capturedSec) {
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
    if (dirty) { this.#prune(); this.#save(); }
  }

  #prune() {
    const cutoff = Date.now() / 1000 - POINT_RETENTION;
    for (const k of Object.keys(this.points)) {
      let kept = this.points[k].filter((s) => s.at >= cutoff);
      if (kept.length > MAX_POINT_SAMPLES) kept = kept.slice(kept.length - MAX_POINT_SAMPLES);
      this.points[k] = kept;
    }
  }

  /**
   * 满额估计。`budget` 取自当帧（上游改档后旧样本的预算点即失效，必须乘当前值）；
   * `group` 给定时只计该模型档位组的支出，用于 modelScoped 窗口。
   * 返回 { fullUSD, confidence, observations, coveredPercent } 或 null。
   */
  estimate(label, ledger, budget = null, group = null) {
    const samples = this.points[label] ?? [];
    const useBudget = budget ?? samples[samples.length - 1]?.budget;
    if (samples.length < 2 || !(useBudget > 0)) return null;

    const { obs, dropped } = this.#observe(samples, ledger, group);
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
   * 挂起增量超时 ⇒ 记一段他机活跃，与其（含 FOREIGN_PAD 扩散）相交的观测剔除。
   */
  #observe(samples, ledger, group) {
    const obs = [];
    const foreign = [];   // 他机活跃时段 [from, to]
    let pendingCost = 0, pendingUnit = 0, unitSince = null, spanStart = null;
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = samples[i], b = samples[i + 1];
      if (b.resetAt !== a.resetAt || b.used < a.used) {
        pendingCost = 0; pendingUnit = 0; unitSince = null; spanStart = null; continue;
      }
      const cost = ledger.spent(a.at, b.at, { group });
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
    const kept = foreign.length
      ? obs.filter((o) => !foreign.some(([f, t]) => o.to >= f - FOREIGN_PAD && o.from <= t + FOREIGN_PAD))
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
