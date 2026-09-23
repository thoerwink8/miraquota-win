#!/usr/bin/env node
/**
 * 账本迁移与对账（一条命令干完"旧数据搬家"这件事）。
 *
 *   node scripts/store-migrate.mjs --import                  # 扫原始记录 → 写进 store.db（去重、幂等）
 *   node scripts/store-migrate.mjs --report --days 8         # 对账报告：两边各记多少、差在哪
 *   node scripts/store-migrate.mjs --tasks --days 7          # 任务/工作区报表
 *   node scripts/store-migrate.mjs --rollup --keep-days 90   # 明细汇进 hourly 后删掉（永久保留汇总）
 *   node scripts/store-migrate.mjs --pack /tmp/store.db      # 出一份单文件快照（迁 VPS 用）
 *   node scripts/store-migrate.mjs --inspect /tmp/store.db   # 校验一份快照能不能用
 *
 * **同一套代码服务三件事**，这是"月底迁 VPS 怎么复用"的答案：
 *   1. 旧数据迁移（今天这次）——扫原始记录重建；
 *   2. 换机器/换盘——把原始记录一起带过去再 `--import`，或 `--pack` 单文件搬过去；
 *   3. 新 VPS 上线——`--pack` → scp → `--inspect` 校验 → 就地打开。
 * 三条路都只用 `sources.mjs`（读）+ `store.mjs`（写），没有第二份导入逻辑。
 *
 * 只读用户的原始记录；`store.db` 是**新增**文件，不碰现役的 ledger.json，所以随时可以跑。
 */
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { UsageStore, STORE_FILE, STORE_SCHEMA, DETAIL_DAYS } from '../provider/lib/store.mjs';
import { Pricing } from '../provider/lib/pricing.mjs';
import { gatewayRows, transcriptRows, turnRows, sourcePaths } from '../provider/lib/sources.mjs';
import { cleanMachineId } from '../provider/lib/ledger-sync.mjs';
import { hostname } from 'node:os';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const num = (n, d) => { const v = Number(opt(n, d)); return Number.isFinite(v) ? v : d; };

const FILE = opt('store', process.env.MIRAQUOTA_STORE || STORE_FILE);
const HOME = opt('home', homedir());
const DAYS = num('days', 8);
const machine = opt('machine', cleanMachineId(hostname()));
const paths = sourcePaths(HOME);
const pricing = new Pricing(opt('pricing', join(HOME, '.mirasim', 'models-dev-cache.json')));

const usd = (v) => '$' + Number(v ?? 0).toFixed(2);
const pad = (s, n) => String(s ?? '').padEnd(n);
const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const hhmm = (sec) => new Date(sec * 1000).toISOString().slice(11, 16);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

if (flag('help') || argv.length === 0) {
  console.log(`用法 node scripts/store-migrate.mjs <动作> [选项]

  --import            扫 transcript / 网关 / 会话轮次，写进 store.db（幂等，可重复跑）
  --report            对账报告：两来源各记多少、缺口在哪、官方点数对上没有
  --tasks             任务与会话报表（含"归不上任务"的部分）
  --reprice           按**当前**价目表重算全库美元（补了价目之后修历史，明细还在的部分）
  --rollup            把 --keep-days 之前的明细汇进 hourly 再删（先汇总后删，顺序不可反）
  --pack <文件>       出一份一致的单文件快照（VACUUM INTO）
  --inspect <文件>    校验快照：schema 版本、integrity、行数、时间跨度

  --store <路径>      store.db 落点，默认 ${STORE_FILE}
  --home <路径>       原始记录所在的家目录，默认 ${HOME}
  --machine <id>      写进流水的机器 id，默认本机名
  --days <N>          报告窗口，默认 8
  --keep-days <N>     明细保留天数，默认 ${DETAIL_DAYS}（store.mjs 的 DETAIL_DAYS，磁盘代价见 docs/STORE.md）
  --basis <口径>      max / t / g / union（默认沿用库里存的）`);
  process.exit(argv.length === 0 ? 1 : 0);
}

/* ---------------- 打包/校验：不需要开主库 ---------------- */
if (flag('inspect')) {
  const info = UsageStore.inspect(opt('inspect'));
  console.log(`快照 ${info.file}`);
  console.log(`  schema ${info.version} · integrity ${info.integrity} · 明细 ${info.calls} 行 · 小时汇总 ${info.rolled} 行`);
  console.log(`  时间跨度 ${info.from ? `${day(info.from)} ${hhmm(info.from)} → ${day(info.to)} ${hhmm(info.to)}` : '（空）'}`);
  // 退出码要跟着 STORE_SCHEMA 走，别写死数字：写死过一次（=== 1），升到 2 之后 --inspect
  // 对着一份完好的快照返回 1，脚本里 `--inspect && 用` 会莫名其妙地不走。
  process.exit(info.integrity === 'ok' && info.version === STORE_SCHEMA ? 0 : 1);
}

const store = new UsageStore({ file: FILE, machine, ...(opt('basis') ? { basis: opt('basis') } : {}) });

if (flag('pack')) {
  const target = opt('pack');
  store.pack(target);
  const info = UsageStore.inspect(target);
  console.log(`已打包 ${target}（${info.calls} 行明细 + ${info.rolled} 行小时汇总，schema ${info.version}）`);
  store.close();
  process.exit(0);
}

/* ---------------- 导入 ---------------- */
if (flag('import')) {
  const cutoff = num('since', Math.floor(Date.now() / 1000 - num('import-days', 400) * 86400));
  const t0 = Date.now();
  const counts = { t: 0, g: 0, d: 0, turns: 0 };
  let added = 0;
  const batch = [];
  const flush = () => { if (batch.length) { added += store.insertCalls(batch); batch.length = 0; } };

  for (const row of transcriptRows({ root: paths.transcripts, cutoff, pricing, machine })) {
    batch.push(row); counts[row.src]++;
    if (batch.length >= 5000) flush();
  }
  for (const row of gatewayRows({ dir: paths.gateway, cutoff, pricing, machine })) {
    batch.push(row); counts[row.src]++;
    if (batch.length >= 5000) flush();
  }
  flush();

  const turns = [...turnRows({ dir: paths.sessions, cutoff })].filter((t) => t.task);
  store.insertTurns(turns);
  counts.turns = turns.length;

  // 标定采样：官方点数（对账的分子）+ 同瞬的各模型累计美元（倍率的分子分母配对）。
  // 旧版 calibration.json 存的是**增量** marks（还有 gap 标记），这里换算成累计并给 gap 打上
  // broken——累计相减与 tick 是否连续无关，跨 broken 的区间由查询层丢掉。
  const cal = readJson(join(HOME, '.miraquota', 'calibration.json'));
  let pts = 0, marks = 0;
  if (cal?.points) {
    const rows = [];
    for (const [label, list] of Object.entries(cal.points)) {
      for (const s of list ?? []) rows.push({ label, at: s.at, used: s.used, budget: s.budget, resetAt: s.resetAt });
    }
    pts = store.insertPoints(rows);
  }
  if (Array.isArray(cal?.marks) && cal.marks.length) {
    const cum = {};
    for (const m of cal.marks) {
      if (m.gap) { store.insertMarks(m.at, cum, { broken: true }); marks++; continue; }
      for (const [model, d] of Object.entries(m.d ?? {})) cum[model] = (cum[model] ?? 0) + d;
      store.insertMarks(m.at, cum);
      marks++;
    }
  }
  console.log(`  标定点数 ${pts} 条 · 标定 marks ${marks} 条`);
  store.clearNeedsImport();

  const span = store.db.prepare('SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n FROM calls').get();
  console.log(`导入完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  console.log(`  读到 transcript ${counts.t} 行 · 网关 ${counts.g} 行 · dispatch ${counts.d} 行 · 轮次 ${counts.turns} 条`);
  console.log(`  新插入 ${added} 行（重复的按主键去重并取较大值），库里现有 ${span.n} 行`);
  console.log(`  时间跨度 ${span.a ? `${day(span.a)} → ${day(span.b)}` : '（空）'}`);
  console.log(`  口径 ${store.basis} · ${FILE}`);
}

/* ---------------- 对账报告 ---------------- */
if (flag('report')) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - DAYS * 86400;
  const rows = store.reconcile(from, to);
  const bySource = store.bySource(from, to);
  const total = store.spend(from, to);
  const live = store.db.prepare('SELECT side, SUM(usd) usd, COUNT(*) n FROM calls WHERE billable=1 AND ts>=? AND ts<? GROUP BY side').all(from, to);

  console.log(`\n== 对账 · 近 ${DAYS} 天（${day(from)} → ${day(to)}）· 口径 ${store.basis} ==`);
  console.log(`生效花费 ${usd(total.usd)}（${total.calls} 笔）`);
  const withDaily = store.totalWithDaily(from, to);
  if (withDaily.rolledUSD > 0) {
    console.log(`  另有 ${usd(withDaily.rolledUSD)} 来自已汇总的老明细（明细只留最近若干天，报表要连它一起看）→ 合计 ${usd(withDaily.usd)}`);
  }
  console.log(`原始两边：${live.map((r) => `${r.side === 't' ? 'transcript' : '网关'} ${usd(r.usd)}/${r.n} 笔`).join(' · ')}`);
  if (bySource.length) {
    console.log('按来源：');
    for (const r of bySource) console.log(`  ${pad(r.src === 't' ? 'transcript' : r.src === 'd' ? 'dispatch' : '网关', 12)} ${pad(usd(r.usd), 12)} ${r.n} 笔`);
  }
  const notable = rows.filter((r) => r.gapWorthReporting);
  console.log(notable.length ? '缺口（网关记得更多 ⇒ 这段 transcript 缺）：' : '缺口：无（两边一致或 transcript 更全）');
  for (const r of notable.slice(0, 8)) {
    console.log(`  ${pad(r.model, 24)} transcript ${pad(usd(r.t), 10)} 网关 ${pad(usd(r.g), 10)} 差 ${usd(r.gap)}`);
  }
  const unpriced = store.unpriced(from, to);
  if (unpriced.length) {
    console.log('无价模型（token 记下了、美元算不出）：');
    for (const r of unpriced.slice(0, 8)) console.log(`  ${pad(r.model, 24)} ${r.tokens} tokens / ${r.n} 笔`);
  }
  // 官方点数：**必须与账本同一个时间窗**才谈得上比值。点数样本只保留 3 天，所以窗口取
  // "当前 resetAt 那组样本的首尾"，而不是日历上的近 7 天——两者错开时算出来的点/$ 没有意义
  // （第一次跑就是这么错的：分子是采样窗口、分母是日历 7 天，得出 10.6 点/$）。
  //
  // 读法（方向别记反）：账号点数是**账号级**的，本机账本只含本机花费。他机花得多 ⇒ 分子不变
  // 分母不变... 准确说：点数涨、本机美元不涨 ⇒ 比值**偏高**。所以
  //   比值 ≫ 200：本机不是主要花费方（或者本机账本漏了）；
  //   比值 < 100：本机账本**虚高**（重复计、价目填错）——这才要查。
  for (const label of ['5h', '7d']) {
    const g = store.db.prepare(`SELECT MIN(at) a, MAX(at) b, COUNT(*) n FROM points
      WHERE label = ? AND reset_at = (SELECT reset_at FROM points WHERE label = ? ORDER BY at DESC LIMIT 1)`)
      .get(label, label);
    if (!g?.a || g.n < 2) continue;
    const pts = store.db.prepare(`SELECT SUM(used) s FROM (
      SELECT used - LAG(used) OVER (ORDER BY at) used FROM points
      WHERE label = ? AND reset_at = (SELECT reset_at FROM points WHERE label = ? ORDER BY at DESC LIMIT 1)
    ) WHERE used > 0`).get(label, label).s ?? 0;
    const w = store.spend(g.a, g.b);
    const machines = store.db.prepare('SELECT COUNT(DISTINCT machine) n FROM calls WHERE ts >= ? AND ts < ?').get(g.a, g.b).n;
    const head = `官方 ${pad(label, 4)} ${day(g.a)} ${hhmm(g.a)}→${hhmm(g.b)}（${g.n} 个采样）点数增量 ${pts.toFixed(0)}`;
    if (w.usd < 1) {
      console.log(`${head} · 本机这段时间只花了 ${usd(w.usd)}——账号点数基本是他机的，比值无意义`);
      continue;
    }
    console.log(`${head} · 本机账本 ${usd(w.usd)} → ${(pts / w.usd).toFixed(1)} 点/$`
      + `（1× 模型应 ~100，fable 应 ~200；本机口径，他机花得越多这个比值越高${machines > 1 ? `，这份库含 ${machines} 台机器` : ''}）`);
  }
}

/* ---------------- 任务/会话报表 ---------------- */
if (flag('tasks')) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - DAYS * 86400;
  const t = store.byTask(from, to);
  console.log(`\n== 任务 · 近 ${DAYS} 天（口径 ${store.basis}）==`);
  console.log(`总花费 ${usd(t.total)}：能归到任务的 ${usd(t.claimed)}（${t.total > 0 ? (t.claimed / t.total * 100).toFixed(0) : 0}%），归不上的 ${usd(t.unclaimed)}`);
  for (const r of t.rows.slice(0, 12)) {
    console.log(`  ${pad(r.task, 22)} ${pad(r.sid?.slice(0, 8) ?? '', 10)} ${pad(usd(r.usd), 10)} ${pad(r.n + ' 笔', 8)} ${day(r.first_at)} ${hhmm(r.first_at)}→${hhmm(r.last_at)}`);
  }
  const ws = store.byWorkspace(from, to);
  console.log(`\n== 工作区 · 近 ${DAYS} 天 ==`);
  for (const r of ws.slice(0, 12)) console.log(`  ${pad(usd(r.usd), 10)} ${pad(r.sessions + ' 会话', 10)} ${r.ws}`);
  const sess = store.bySession(from, to);
  console.log(`\n== 会话（top 10）==`);
  for (const r of sess.slice(0, 10)) {
    console.log(`  ${pad(r.sid?.slice(0, 8) ?? '(无会话)', 10)} ${pad(usd(r.usd), 10)} ${pad(r.n + ' 笔', 8)} ${pad((r.models ?? '').slice(0, 40), 42)} ${day(r.first_at)} ${hhmm(r.first_at)}→${hhmm(r.last_at)}`);
  }
}

/* ---------------- 按当前价目重算 ---------------- */
if (flag('reprice')) {
  const before = store.db.prepare('SELECT ROUND(SUM(usd), 4) usd FROM calls WHERE billable = 1').get().usd ?? 0;
  const r = store.reprice({ pricing });
  const after = store.db.prepare('SELECT ROUND(SUM(usd), 4) usd FROM calls WHERE billable = 1').get().usd ?? 0;
  console.log(`\n== 重算 ==`);
  console.log(`  模型 ${r.models} 个 · 改动 ${r.calls} 行 · 汇总层重算 ${r.hourly} 行`);
  console.log(`  计费美元合计 ${usd(before)} → ${usd(after)}`);
  if (r.hourlyStale) {
    console.log(`  注意：汇总层还有 ${r.hourlyStale} 行**没动**——那些小时的明细已被修剪，`
      + '没有原始 token 可重算，只能保持原样（要修它们得先 --import 把明细扫回来）');
  }
  if (r.unpriced.length) {
    console.log(`  仍然没价（只记 token）：${r.unpriced.join('、')}`);
    console.log('  补进 provider/lib/pricing.mjs 的内置表（或价目缓存）后再跑一次 --reprice 即可。');
  }
}

/* ---------------- 汇总与保留 ---------------- */
if (flag('rollup')) {
  const keep = num('keep-days', DETAIL_DAYS);
  const before = day(Math.floor(Date.now() / 1000 - keep * 86400));
  const r = store.prune({ beforeDay: before });
  console.log(`已把 ${before} 之前的明细汇进 hourly：汇总 ${r.rolled} 组、删除 ${r.deleted} 行`);
}

store.close();
