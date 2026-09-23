/**
 * 拿**真实数据**量各模型的点数倍率，并给出「旧口径」对照（一次性核算，手动跑）。
 *
 *   node scripts/verify-rate.mjs
 *
 * 为什么要这个脚本：倍率是「点数 ÷ 美元」量出来的，而美元那一侧刚改过口径（2026-09-22
 * 跨源双计）。单元测试只能证明算法在构造数据上对，证明不了真实数据上量出来就是 2.00——
 * 这个脚本用真 transcript + 真网关账本 + 真 /v1/limits 采样，把两件事一起回答：
 *
 *  1. **改之前那套会量出多少**：影子账（网关那份，现在只用来对账）也在状态里，把它加回去
 *     就是旧的「两源并集」口径，于是每个模型都有「新 ×N / 旧 ×M」两个数并排。
 *  2. **官方锚点还在不在**：1× 的模型（opus/sonnet）应当量出 ×1.0，fable 应当 ×2.0。
 *     官方「额度点 ÷ 100 = 美元」是这套算法的地基，量出 1.0 才说明地基没动。
 *
 * 读什么、写什么：只读 ~/.claude/projects、~/.mirasim/insights、~/.miraquota/calibration.json，
 * 状态写临时目录，**不碰** ~/.miraquota/ledger.json（跑着的 provider 内存里有整份状态，
 * 动它会被下一次 #save 整份盖掉）。所以这个脚本可以随时跑，不用停 Mirasim。
 *
 * 怎么读输出：
 *  - 按 resetAt 分组（账号周期一换 used 归零，跨组相减是负数）；
 *  - 段 = 相邻两个点数样本之间，只保留「这一段只有一个模型在花钱」的（多个模型同时在花，
 *    分不清点数是谁的）；各段相加会望远镜相消，于是整条链的美元 = c(末) − c(首)，
 *    与点数增量同一个时间窗，分钟桶的边界误差只剩两端各一分钟；
 *  - **美元很小而点数很大的那几行不是读数，是他机污染**：点数是账号级、账本是本机级，
 *    另一台机器在花 fable 时，本机只花了 $0.05 的 sonnet 也会被算成「这一段只有 sonnet
 *    在花钱」，于是量出 ×38 这种数。看的是美元量级够大的那几行。
 *
 * 2026-09-23 实跑（本机，改完当天；新 / 旧 = transcript 口径 / 两源并集口径）：
 *
 *   7d        · fable-5-1  74 段 $72.18 → ×1.923   （旧口径 $128.02 → ×1.084）
 *   7d_fable  · fable-5-1  73 段 $71.92 → ×1.843   （旧口径 $127.64 → ×1.038）
 *   5h        · fable-5-1  29 段 $21.63 → ×1.998   （旧口径 $42.86  → ×1.008）
 *   7d        · opus-5     61 段 $57.46 → ×1.001   （旧口径 $91.77  → ×0.627）
 *   5h        · opus-5     57 段 $53.68 → ×0.991   （旧口径 $87.23  → ×0.610）
 *
 * 读出来两件事：fable 从「1.0 上下」回到 2.0 附近（1.84–2.26，散的是他机污染），而 1× 的
 * opus 从 0.61 回到 0.99–1.00——**两边同时回到各自的真值**，说明偏差是口径的、不是某个
 * 模型的价目填错。旧口径的虚高倍数在这批数据上是 1.77×（fable）/ 1.60×（opus）。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { CostLedger } = await import(`file:///${join(ROOT, 'provider/lib/ledger.mjs').replace(/\\/g, '/')}`);
const { Pricing } = await import(`file:///${join(ROOT, 'provider/lib/pricing.mjs').replace(/\\/g, '/')}`);

const dir = mkdtempSync(join(tmpdir(), 'mq-verify-rate-'));
const led = new CostLedger(new Pricing(join(homedir(), '.mirasim', 'models-dev-cache.json')), join(dir, 'ledger.json'));
led.adoptScopedGroups(['fable', 'claude']);   // 顺序要紧：先声明档位组，重扫才记得进档位桶
const t0 = Date.now();
led.refresh(Date.now());
console.log(`全量重扫 ${((Date.now() - t0) / 1000).toFixed(1)}s，分钟桶 ${led.bucketCount}\n`);

const models = led.modelIds();
const cum = new Map(models.map((m) => [m, (t) => led.spent(0, t, { includeOpenMinute: true, model: m })]));

// 旧口径（两源并集）= transcript + 网关影子账。影子账就在刚写出的临时状态文件里。
const state = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
const shadowCum = (model) => {
  const pre = model + '|';
  const rows = Object.entries(state.shadow ?? {})
    .filter(([k]) => k.startsWith(pre))
    .map(([k, v]) => [Number(k.slice(pre.length)), v])
    .sort((a, b) => a[0] - b[0]);
  const at = [];
  let acc = 0;
  for (const [m, v] of rows) { acc += v; at.push([m, acc]); }
  return (t) => {
    const lim = Math.floor(t / 60);
    let lo = 0, hi = at.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (at[mid][0] <= lim) lo = mid + 1; else hi = mid; }
    return lo ? at[lo - 1][1] : 0;
  };
};

const cal = JSON.parse(readFileSync(join(homedir(), '.miraquota', 'calibration.json'), 'utf8'));
for (const label of ['5h', '7d', '7d_fable']) {
  const all = cal.points?.[label] ?? [];
  const groups = new Map();
  for (const x of all) {
    if (!groups.has(x.resetAt)) groups.set(x.resetAt, []);
    groups.get(x.resetAt).push(x);
  }
  for (const [resetAt, s] of groups) {
    if (s.length < 2) continue;
    const per = new Map();
    for (let i = 0; i + 1 < s.length; i++) {
      const a = s[i], b = s[i + 1];
      if (!(b.used > a.used)) continue;
      const usd = {};
      for (const m of models) {
        const d = cum.get(m)(b.at) - cum.get(m)(a.at);
        if (d > 0.01) usd[m] = d;
      }
      const keys = Object.keys(usd);
      if (keys.length !== 1) continue;                    // 不止一个模型在花，点数归不到谁头上
      const m = keys[0];
      const sc = shadowCum(m);
      const row = per.get(m) ?? { points: 0, usd: 0, oldUSD: 0, segs: 0 };
      row.points += b.used - a.used;
      row.usd += usd[m];
      row.oldUSD += usd[m] + (sc(b.at) - sc(a.at));
      row.segs++;
      per.set(m, row);
    }
    const span = `${new Date(s[0].at * 1000).toISOString()} → ${new Date(s[s.length - 1].at * 1000).toISOString()}`;
    console.log(`== ${label} · 周期 ${new Date(resetAt * 1000).toISOString()}（${s.length} 样本，${span}）==`);
    const rows = [...per.entries()].sort((x, y) => y[1].usd - x[1].usd);
    if (!rows.length) console.log('   （没有「只有一个模型在花钱」的段）');
    for (const [m, r] of rows) {
      const now = r.points / r.usd / 100;
      const old = r.oldUSD > 0 ? r.points / r.oldUSD / 100 : NaN;
      console.log(`   ${m.padEnd(22)} ${String(r.segs).padStart(4)} 段  $${r.usd.toFixed(2).padStart(8)}`
        + `  ${r.points.toFixed(0).padStart(7)} 点  → ×${now.toFixed(3)}   （旧口径 $${r.oldUSD.toFixed(2)} → ×${old.toFixed(3)}）`);
    }
    console.log('');
  }
}
