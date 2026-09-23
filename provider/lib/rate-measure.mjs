/**
 * 按模型实测点数倍率：官方点数增量 ÷ 同一瞬间的账本美元增量 ÷ 100。
 *
 * 为什么不是「整窗总量相除」（2026-09-22 用户：「fable5.1 和 fable5 的倍率一直算不准」）：
 * 原先 `measureGroupRatio` 拿 `(非该组美元/非该组点数) ÷ (该组美元/该组点数)`，三处一起拖偏——
 *  1. 分母是**测出来的**非该组单价，本身带噪；而官方 ÷100 早已确认（engine.mjs OFFICIAL_PER_POINT），
 *     倍率只需要一个计数器就能定，不必再拿第二个噪声量去除；
 *  2. 整窗求和把**时间错位**和**他机用量**烧进结果，逐段看多数段正好 200 点/$、少数段 40 或 443，
 *     Σ÷Σ 把偏差留着，取中位数能整掉；
 *  3. 粒度只到档位组（子串 `fable`），fable-5 与 fable-5-1 并成一桶，结构上问不出各自的倍率。
 *
 * 换成：**只用「这一段只有一个模型在花钱」的采样区间**，逐段算点/美元，按美元加权取中位数。
 * 关键是两侧同一瞬间取数——点数读数与各模型累计美元在同一个 tick 里记下（见 Calibrator.record
 * 的 marks），点数样本也只落在有 mark 的那些 tick 上，所以一段的美元 = 段内各条 mark 增量之和，
 * 分子分母是同一个时间窗，不需要按分钟取整。分钟桶做过一版，p25/p75 散到 0.97/3.27
 * （边界最多差 60 秒，而一段常常只有两三分钟），弃了。
 *
 * 本机实测：claude-fable-5-1 中位 ×2.00（另一条独立量法：逐段配「同瞬账本美元」的中位数
 * 也是 200.0 点/$, p25 = p75 = 200.0）。段太少就如实说样本不足，不给一个由噪声算出的数。
 */

/** 官方汇率的点数侧：额度点 ÷ 100 = 美元，故基准是每美元 100 点（倍率 1 的模型）。 */
export const POINTS_PER_USD = 100;

const MIN_SEG_USD = 0.2;     // 段内支出下限：太小的段一次取整误差就能翻倍
const MIN_TOTAL_USD = 2;     // 给出一个模型的倍率所需的累计支出
const MIN_SEGMENTS = 3;      // 给出一个模型的倍率所需的段数

/**
 * @param samples 某窗口的点数样本 [{ at, used, resetAt }]（Calibrator.points[label]）
 * @param marks   同一批 tick 上的各模型美元增量 [{ at, d: { model: usd } }]；`gap` 为真表示
 *                这一刻之前的累计基准断了（重启、修剪），跨它的区间不可用
 * @returns [{ model, multiplier, p25, p75, segments, usd, points, confidence }] 按支出降序
 */
export function measureModelRates(samples, marks, opts = {}) {
  const minSegUSD = opts.minSegUSD ?? MIN_SEG_USD;
  const list = [...(samples ?? [])].sort((a, b) => a.at - b.at);
  // mark 是**增量**（相对上一条 mark），所以一段的美元不是「b 那一条」，而是 (a.at, b.at]
  // 里所有 mark 之和。只取 b 那一条会漏掉中间那些 mark——点数样本的间隔门与 mark 的间隔门
  // 各自独立时，某款模型值没变的那一轮只记 mark 不记点数，一段里就能有好几条 mark。
  const markList = [...(marks ?? [])].sort((a, b) => a.at - b.at);
  const idxAt = new Map();
  markList.forEach((m, i) => idxAt.set(m.at, i));
  if (list.length < 2 || !markList.length) return [];

  const perModel = new Map();
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i], b = list[i + 1];
    if (b.resetAt !== a.resetAt || b.used <= a.used) continue;   // 跨重置或没涨，无从比
    // 两端都必须踩在 mark 上：求和从 a.at 的下一条起算，才恰好是 (a.at, b.at] 的花费；
    // 缺 a.at 那一条就会把 a.at 之前的一段算进来，缺 b.at 那条则漏掉尾巴。
    const ia = idxAt.get(a.at), ib = idxAt.get(b.at);
    if (ia == null || ib == null || ib <= ia) continue;
    const seg = markList.slice(ia + 1, ib + 1);
    if (seg.some((m) => m.gap)) continue;                        // 基准断过，这一段不可信
    const d = {};
    for (const m of seg) for (const [model, usd] of Object.entries(m.d ?? {})) d[model] = (d[model] ?? 0) + usd;
    const deltas = Object.entries(d).filter(([, usd]) => usd !== 0);
    if (deltas.length !== 1) continue;                           // 没花钱、或不止一个模型在花
    const [model, usd] = deltas[0];
    if (!(usd >= minSegUSD)) continue;                           // 含负数（分片轮换）时也在这里被挡掉
    const points = b.used - a.used;
    if (!perModel.has(model)) perModel.set(model, []);
    perModel.get(model).push({ multiplier: points / usd / POINTS_PER_USD, usd, points });
  }

  const out = [];
  for (const [model, rows] of perModel) {
    const usd = rows.reduce((s, r) => s + r.usd, 0);
    if (!(usd >= MIN_TOTAL_USD) || rows.length < MIN_SEGMENTS) continue;
    out.push({
      model,
      multiplier: weightedQuantile(rows, 0.5),
      p25: weightedQuantile(rows, 0.25),
      p75: weightedQuantile(rows, 0.75),
      segments: rows.length,
      usd,
      points: rows.reduce((s, r) => s + r.points, 0),
      confidence: rows.length >= 12 && usd >= 10 ? 'high' : (rows.length >= 6 ? 'medium' : 'low'),
    });
  }
  return out.sort((a, b) => b.usd - a.usd);
}

/**
 * 档位组的实测倍率：组内各模型的实测值按支出加权取中位。
 * `agree` 为假表示组内两个模型量出来不一样——那个「一个组一个倍率」的配置本身就是个混合值，
 * 界面该把两行都摆出来，而不是只给一个数。
 */
export function groupRate(rates, group) {
  const g = String(group || '').toLowerCase();
  const members = (rates ?? []).filter((r) => r.model.includes(g));
  if (!members.length) return null;
  const rows = members.map((r) => ({ multiplier: r.multiplier, usd: r.usd }));
  const hi = Math.max(...members.map((r) => r.multiplier));
  const lo = Math.min(...members.map((r) => r.multiplier));
  return {
    group: g,
    multiplier: weightedQuantile(rows, 0.5),
    members,
    usd: rows.reduce((s, r) => s + r.usd, 0),
    segments: members.reduce((s, r) => s + r.segments, 0),
    agree: lo > 0 ? hi / lo <= 1.05 : false,
    confidence: members.some((r) => r.confidence === 'high') ? 'high'
      : (members.some((r) => r.confidence === 'medium') ? 'medium' : 'low'),
  };
}

/** 按美元加权的分位数：错位段的比率堆在两侧，中位最多容忍近半污染。 */
function weightedQuantile(rows, p) {
  const sorted = [...rows].sort((a, b) => a.multiplier - b.multiplier);
  const target = sorted.reduce((s, r) => s + r.usd, 0) * p;
  let acc = 0;
  for (const r of sorted) {
    acc += r.usd;
    if (acc >= target) return r.multiplier;
  }
  return sorted[sorted.length - 1]?.multiplier ?? null;
}
