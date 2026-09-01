/**
 * 账本美元与 /v1/limits 额度点的自洽性核算。移植自 Swift 版 LedgerCoherence.swift。
 *
 * 兜底满额是「每点美元 × 预算点」，每点美元只能由本机账本反推，账本超算或点数漏计会把
 * 满额同倍放大。窗口之间互为交叉验证：5h 是 7d 的时间子集，两者反推的每点美元应同量级，
 * 离散超阈值说明至少一侧失真而无从判定哪侧，此时不给美元。
 *
 * 档位倍率折算（2026-09-02）：官方对 fable 按 2 倍计量点数，同样一份支出走 fable 扣的点
 * 是走 opus 的 2 倍。不折算，「每点美元」会被 fable 用量拖低，满池价值系统性低估
 * （本机实测：不分组 0.00445 $/点 vs 按 2× 折算 0.00646）。折算办法是把 fable 那部分支出
 * 按倍率放大再除总点数——得到的是**非 fable 的基准单价**，与官方「不用 fable 时 5600」同口径。
 */
import { windowDuration } from './windows.mjs';

const MIN_POINTS = 200;         // 参与反推的最低已用点数
const MIN_POINTS_CROSS = 500;   // 参与交叉验证的最低已用点数
const MAX_SPREAD = 4;           // 每点美元的跨窗口离散上限（同机实测跨 2.1×，取 4× 留余量）

/**
 * 一段时间内按档位倍率折算后的等效支出。
 * @param groupCost { fable: 2 } 形式的倍率表；空表或全 1 时结果等于原始支出。
 * @returns { usd, raw, adjustments } —— adjustments 逐组记明细，供界面交代来源。
 */
export function weightedSpend(ledger, fromSec, toSec, groupCost = {}) {
  const raw = ledger.spent(fromSec, toSec, { includeOpenMinute: true });
  const adjustments = [];
  let usd = raw;
  for (const [group, ratio] of Object.entries(groupCost)) {
    if (!(ratio > 0) || ratio === 1) continue;
    const groupUSD = ledger.spent(fromSec, toSec, { includeOpenMinute: true, group });
    if (!(groupUSD > 0)) continue;
    usd += (ratio - 1) * groupUSD;      // 该组每一美元实际扣了 ratio 倍的点
    adjustments.push({ group, ratio, usd: groupUSD });
  }
  return { usd, raw, adjustments };
}

/** modelScoped 窗口不参与：其账本分桶自档位声明起才累积，支出系统性偏低。 */
export function evaluateCoherence(windows, ledger, nowSec, groupCost = {}) {
  const rates = [];
  for (const w of windows) {
    if (w.modelScoped || w.used < MIN_POINTS) continue;
    const dur = windowDuration(w.label);
    if (!dur) continue;
    const start = w.resetAt - dur;
    const { usd, raw, adjustments } = weightedSpend(ledger, start, nowSec, groupCost);
    if (usd <= 0) continue;
    rates.push({ label: w.label, points: w.used, usd, rawUSD: raw, adjustments, perPoint: usd / w.used });
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

/**
 * 实测倍率：非该组单价 ÷ 该组单价，两个数各来自一个**独立的官方计数器**
 * （总窗的点数、该档位窗的点数），不是本机分摊，所以可以拿来对表官方口径。
 * 样本不足或分母为零时返回 null——宁可不给，也不给一个由噪声算出的倍率。
 * @returns { group, measured, groupPerPoint, otherPerPoint } | null
 */
export function measureGroupRatio(windows, ledger, nowSec, group) {
  const pool = windows.find((w) => !w.modelScoped && windowDuration(w.label));
  const scoped = windows.find((w) => w.modelScoped && w.label.endsWith(`_${group}`));
  if (!pool || !scoped) return null;
  const poolDur = windowDuration(pool.label);
  const poolStart = pool.resetAt - poolDur;
  const poolUSD = ledger.spent(poolStart, nowSec, { includeOpenMinute: true });
  const groupUSD = ledger.spent(poolStart, nowSec, { includeOpenMinute: true, group });
  const otherUSD = poolUSD - groupUSD;
  const otherPoints = pool.used - scoped.used;
  if (!(groupUSD > 0) || !(otherUSD > 0) || !(scoped.used > MIN_POINTS) || !(otherPoints > MIN_POINTS)) {
    return null;
  }
  const groupPerPoint = groupUSD / scoped.used;
  const otherPerPoint = otherUSD / otherPoints;
  if (!(groupPerPoint > 0)) return null;
  return { group, measured: otherPerPoint / groupPerPoint, groupPerPoint, otherPerPoint };
}

/** 兜底停用的原因，供显示面共用一套说法。自洽时为 null。 */
export function coherenceNotice(result) {
  if (!result.incoherent || result.spread == null) return null;
  return `回归标定优先 · 兜底停用：账本与点数不自洽（离散 ${result.spread.toFixed(1)}×）`;
}
