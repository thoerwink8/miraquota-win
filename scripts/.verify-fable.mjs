// 一次性核算草稿（未跟踪）：按「fable 点数 k 倍计量」反推 7d 池的满额美元，与官方 5600 对表。
import { Engine } from '../provider/lib/engine.mjs';

const engine = new Engine();
await engine.loadSpeed();
await engine.poll();
const p = engine.payload();

const w7 = p.windows.find((w) => w.label === '7d');
const wf = p.windows.find((w) => w.label === '7d_fable');
if (!w7 || !wf) { console.error('缺 7d / 7d_fable 窗口'); process.exit(1); }

const usdTotal = w7.spentUSD;            // 7d 窗内全模型账本支出（本机+已合并的他机）
const usdFable = wf.spentUSD;            // 同期仅 fable 组
const usdOther = usdTotal - usdFable;
const ptsTotal = w7.points.used;
const ptsFable = wf.points.used;
const ptsOther = ptsTotal - ptsFable;
const budget = w7.points.budget;

const f = (n, d = 2) => Number(n).toFixed(d);
console.log(`7d 窗：账本 $${f(usdTotal)}（其中 fable $${f(usdFable)}、其余 $${f(usdOther)}）`);
console.log(`      点数 ${ptsTotal}（fable ${ptsFable}、其余 ${ptsOther}）/ 预算 ${budget}`);
console.log('');

const rFable = usdFable / ptsFable;
const rOther = usdOther / ptsOther;
console.log(`实测单价：fable ${f(rFable, 6)} $/点 · 非 fable ${f(rOther, 6)} $/点`);
console.log(`实测倍率：非 fable 单价 ÷ fable 单价 = ${f(rOther / rFable)}×（官方口径 2×）`);
console.log('');

for (const k of [1, 1.5, 2, 2.39, 3]) {
  // 口径：一份 fable 支出扣 k 倍点数 ⇒ 基准单价 r = (非fable$ + k×fable$) ÷ 总点数
  const r = (usdOther + k * usdFable) / ptsTotal;
  console.log(`k=${k}：基准单价 ${f(r, 6)} $/点 → 满池（全用非 fable）= $${f(r * budget, 0)}`
    + `　　对官方 5600 的比 ${f(r * budget / 5600 * 100, 1)}%`);
}
console.log('');
const blended = usdTotal / ptsTotal;
console.log(`当前口径（不分组，blended）：${f(blended, 6)} $/点 → 满池 $${f(blended * budget, 0)}`);
console.log(`官方口径：5600 / ${budget} = ${f(5600 / budget, 6)} $/点`);
process.exit(0);
