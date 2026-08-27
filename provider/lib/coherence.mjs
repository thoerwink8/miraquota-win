/**
 * 账本美元与 /v1/limits 额度点的自洽性核算。移植自 Swift 版 LedgerCoherence.swift。
 *
 * 兜底满额是「每点美元 × 预算点」，每点美元只能由本机账本反推，账本超算或点数漏计会把
 * 满额同倍放大。窗口之间互为交叉验证：5h 是 7d 的时间子集，两者反推的每点美元应同量级，
 * 离散超阈值说明至少一侧失真而无从判定哪侧，此时不给美元。
 */
import { windowDuration } from './windows.mjs';

const MIN_POINTS = 200;         // 参与反推的最低已用点数
const MIN_POINTS_CROSS = 500;   // 参与交叉验证的最低已用点数
const MAX_SPREAD = 4;           // 每点美元的跨窗口离散上限（同机实测跨 2.1×，取 4× 留余量）

/** modelScoped 窗口不参与：其账本分桶自档位声明起才累积，支出系统性偏低。 */
export function evaluateCoherence(windows, ledger, nowSec) {
  const rates = [];
  for (const w of windows) {
    if (w.modelScoped || w.used < MIN_POINTS) continue;
    const dur = windowDuration(w.label);
    if (!dur) continue;
    const start = w.resetAt - dur;
    const usd = ledger.spent(start, nowSec, { includeOpenMinute: true });
    if (usd <= 0) continue;
    rates.push({ label: w.label, points: w.used, usd, perPoint: usd / w.used });
  }
  if (!rates.length) return { perPoint: null, basis: null, spread: null, incoherent: false };

  const best = rates.reduce((a, b) => (b.points > a.points ? b : a));
  const cross = rates.filter((r) => r.points >= MIN_POINTS_CROSS).map((r) => r.perPoint);
  let spread = null;
  if (cross.length >= 2) {
    const hi = Math.max(...cross), lo = Math.min(...cross);
    if (lo > 0) spread = hi / lo;
  }
  const incoherent = spread != null && spread > MAX_SPREAD;
  return {
    perPoint: incoherent ? null : best.perPoint,
    basis: best,
    spread,
    incoherent,
  };
}

/** 兜底停用的原因，供显示面共用一套说法。自洽时为 null。 */
export function coherenceNotice(result) {
  if (!result.incoherent || result.spread == null) return null;
  return `回归标定优先 · 兜底停用：账本与点数不自洽（离散 ${result.spread.toFixed(1)}×）`;
}
