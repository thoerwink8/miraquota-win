/**
 * 一次性排查：这台机器 7 天窗口里 fable 到底花了多少，与官方 /v1/limits 对表。
 *
 * 为什么要单独一份而不看面板：面板的 fable 主行走的是 ledger 的 scoped 分桶，而分桶只
 * 从「这台机器第一次收到 limits」那刻起算（scopedSince）。要问「过去 7 天真花了多少」，
 * 必须拿一份干净状态文件全量重扫，且在 refresh 之前就把 fable 这个档位组打开。
 *
 * 只读：状态文件写到 --state 指定的临时路径，不碰 ~/.miraquota/ledger.json。
 * 用法：node scripts/probe-fable.mjs [--state /tmp/probe-ledger.json] [--days 7|--from <秒>]
 *
 * **对表必须用官方窗口的真起点**（`reset_at - 时长`），不是「最近 7 天」。官方那三个
 * 窗口是定长定点的，账号周期一重置，7d 的起点就跟 5h 一样是刚刚——拿日历 7 天去比，
 * 分子会大出一个数量级，看着像账本坏了，其实是窗口对错了（2026-09-08 就先这么错了一次）。
 */
import { CostLedger } from '../provider/lib/ledger.mjs';
import { Pricing } from '../provider/lib/pricing.mjs';

const opt = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const stateFile = opt('state', '/tmp/miraquota-probe-ledger.json');
const days = Number(opt('days', 7));

const pricing = new Pricing();
const ledger = new CostLedger(pricing, stateFile);
// 顺序要紧：分桶只在入桶那一刻做，refresh 之前不开组，重扫出来的 scoped 还是空的
ledger.adoptScopedGroups(['fable']);
ledger.refresh();

const now = Date.now() / 1000;
const from = Number(opt('from', 0)) || now - days * 86400;
const all = ledger.spent(from, now, { includeOpenMinute: true, localOnly: true });
const fable = ledger.spent(from, now, { includeOpenMinute: true, group: 'fable', localOnly: true });

console.log(`窗口：${new Date(from * 1000).toISOString()} 起，已过 ${((now - from) / 3600).toFixed(1)} 小时`);
console.log(`本机账本总支出   $${all.toFixed(2)}`);
console.log(`其中 fable       $${fable.toFixed(2)}   → 折算 ${(fable * 2 * 100).toFixed(0)} 点（fable 每美元扣 2 点）`);
console.log(`非 fable         $${(all - fable).toFixed(2)}   → 折算 ${((all - fable) * 100).toFixed(0)} 点`);

// 分模型明细：哪些模型名被当成了 fable（scoped 是按模型名含 'fable' 归组的）
const byModel = new Map();
for (const [k, v] of Object.entries(ledger.family)) {
  const [fam, min] = k.split('|');
  if (Number(min) * 60 < from) continue;
  byModel.set(fam, (byModel.get(fam) ?? 0) + v);
}
console.log('\n按家族（同窗口，本机）：');
for (const [fam, usd] of [...byModel].sort((a, b) => b[1] - a[1])) console.log(`  ${fam.padEnd(10)} $${usd.toFixed(2)}`);
