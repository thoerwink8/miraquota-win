/**
 * 满额自校准。移植自 Swift 版 Calibrator.swift（点数口径）。
 *
 * 原始额度点与 API 等价支出在观测窗口内呈线性关系，故满额可由
 * 「一段时间的支出 ÷ 同期点数增量 × 预算点」反推。Windows 上 /v1/limits 可读，
 * 主走点数口径：`used` 是绝对量、跨预算点变更可比，优于 relay 帧的百分比口径。
 *
 * 支出与增量两侧都会挂起到对面也非零时才成为一次观测：只挂起支出会低估满额，
 * 只挂起增量会高估（有请求在途时增量先涨、美元后落）。
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

    const obs = this.#observe(samples, ledger, group);
    if (!obs.length) return null;
    const used = trimOutliers(obs);
    const totalCost = used.reduce((s, o) => s + o.cost, 0);
    const totalUnit = used.reduce((s, o) => s + o.unit, 0);
    if (totalUnit <= 0 || totalCost <= 0) return null;

    const covered = totalUnit / useBudget * 100;
    return {
      fullUSD: totalCost / totalUnit * useBudget,
      confidence: confidenceOf(used.length, covered),
      observations: used.length,
      coveredPercent: covered,
    };
  }

  /** 逐对配对出 (cost, unit) 观测。两侧挂起，窗口滚动或回落即清挂起。 */
  #observe(samples, ledger, group) {
    const obs = [];
    let pendingCost = 0, pendingUnit = 0, unitSince = null;
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = samples[i], b = samples[i + 1];
      if (b.resetAt !== a.resetAt || b.used < a.used) {
        pendingCost = 0; pendingUnit = 0; unitSince = null; continue;
      }
      const cost = ledger.spent(a.at, b.at, { group });
      if (unitSince != null && b.at - unitSince > CARRY_TIMEOUT) { pendingUnit = 0; unitSince = null; }
      pendingCost += cost;
      pendingUnit += b.used - a.used;
      if (pendingCost > 0 && pendingUnit > 0) {
        obs.push({ cost: pendingCost, unit: pendingUnit });
        pendingCost = 0; pendingUnit = 0; unitSince = null;
      } else if (pendingUnit > 0 && unitSince == null) {
        unitSince = b.at;
      }
    }
    return obs;
  }

  pointSampleCount(label) { return (this.points[label] ?? []).length; }
}

/** 按逐对隐含单价裁掉两端各 10%，剔除上游重算配额造成的畸低样本。 */
function trimOutliers(obs) {
  if (obs.length < 10) return obs;
  const sorted = [...obs].sort((a, b) => a.cost / a.unit - b.cost / b.unit);
  const drop = Math.max(1, Math.floor(sorted.length / 10));
  return sorted.slice(drop, sorted.length - drop);
}

function confidenceOf(observations, covered) {
  if (covered >= 20 && observations >= 15) return 'high';
  if (covered >= 5 && observations >= 5) return 'medium';
  return 'low';
}

export { CONFIDENCE, CONFIDENCE_LABEL };
