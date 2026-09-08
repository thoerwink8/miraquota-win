/**
 * 补回某个档位组（fable）漏掉的分钟桶。
 *
 * 什么时候需要它：分钟桶只入一次、不会重扫，所以「入桶那一刻 scopedGroups 还是空的」
 * 那些分钟，档位归属就永久缺失——总额有、fable 主行少一截，没有任何报错。
 * 成因已在代码里堵掉（scopedGroups 落盘 + 空集不覆盖，见 ledger.mjs），本脚本只管
 * 把**堵之前**已经漏掉的补回来。正常情况下一台机器只需要跑一次。
 *
 * 做法：另起一份干净状态文件全量重扫（先开档位组再 refresh），拿它算出的 scoped 去补
 * 现役账本里**缺的键**。
 *
 * 三条自律：
 *  - **只加不改**：现役账本已有的键一个不碰。它那份可能吃到了 relay 的后续回填，比重扫
 *    的更新；重扫这份的价值只在「现役完全没有」的那些分钟。
 *  - **不动 buckets/family**：那些钱早就在总额里了，这里补的只是「算在哪个档位名下」。
 *    动总额就会重复计一遍。
 *  - **先备份**：写回前把原文件复制成 `<名字>.bak-<时间戳>`。
 *
 * 必须先停掉 provider/hub 再跑：跑着的那个进程内存里有整份状态，它下一次 #save 会把
 * 这里的改动整份盖掉。
 *
 * 用法：node scripts/backfill-scoped.mjs [--group fable] [--state <账本路径>] [--apply]
 * 不给 --apply 就是只看不写。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CostLedger } from '../provider/lib/ledger.mjs';
import { Pricing } from '../provider/lib/pricing.mjs';

const opt = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const group = opt('group', 'fable').toLowerCase();
const stateFile = opt('state', join(homedir(), '.miraquota', 'ledger.json'));
const apply = process.argv.includes('--apply');

const live = JSON.parse(readFileSync(stateFile, 'utf8'));   // 解不开就该在这里炸，别硬写
const liveScoped = live.scoped ?? {};

const fresh = new CostLedger(new Pricing(), join(tmpdir(), `mq-backfill-${group}-${Date.now()}.json`));
fresh.adoptScopedGroups([group]);   // 顺序要紧：refresh 之前不开组，重扫出来的 scoped 还是空的
fresh.refresh();

const pre = `${group}|`;
let added = 0, addedUSD = 0, kept = 0, earliest = Infinity;
for (const [k, v] of Object.entries(fresh.scoped)) {
  if (!k.startsWith(pre)) continue;
  if (liveScoped[k] != null) { kept += 1; continue; }
  liveScoped[k] = v;
  added += 1; addedUSD += v;
  earliest = Math.min(earliest, Number(k.slice(pre.length)));
}

const since = live.scopedSince?.[group];
const nextSince = Number.isFinite(earliest) && (since == null || earliest < since) ? earliest : since;

console.log(`档位组 ${group} · 账本 ${stateFile}`);
console.log(`  现役已有 ${kept} 个桶，补进 ${added} 个（$${addedUSD.toFixed(2)}）`);
if (added) console.log(`  最早补到 ${new Date(earliest * 60000).toISOString()}`);
console.log(`  scopedSince：${since ?? '（无）'} → ${nextSince ?? '（无）'}`);

if (!added) { console.log('没有要补的，原文件未改。'); process.exit(0); }
if (!apply) { console.log('\n只看不写（加 --apply 才写回）。先停掉 provider/hub 再 --apply。'); process.exit(0); }

const bak = `${stateFile}.bak-${new Date().toISOString().replace(/[:.]/g, '')}`;
copyFileSync(stateFile, bak);
live.scoped = liveScoped;
live.scopedSince = { ...(live.scopedSince ?? {}), [group]: nextSince };
live.scopedGroups = [...new Set([...(live.scopedGroups ?? []), group])].sort();
writeFileSync(stateFile, JSON.stringify(live));
console.log(`\n已写回。原文件备份：${bak}`);
