/**
 * `JournalLedger`：把 SQLite 流水账包成**旧账本（CostLedger）那套接口**。
 *
 * 为什么要这一层：Engine 与标定/归因/多机同步四处都在调 `spent()` / `familySpent()` /
 * `activeMinutes()` / `cumulativeByModel()` / `exportShard()` 这些方法，语义各不相同。
 * 直接把它们改成 SQL 会把"换个存储"变成"重写一遍业务"，而重写业务正是最容易把口径改坏的
 * 做法（这一路已经因为改口径出过两次事故）。所以这里做的是**同一套接口、换一个实现**：
 * Engine 只换构造那一行，别的一个字节不动，payload 形状与界面零改动。
 *
 * 与旧账本的三处实质差别（都是要的）：
 *  1. **口径**：旧账本是"两个来源相加"（同一笔调用记两次），这里是 `effective` 视图
 *     （默认按 机器×模型×小时 取较大的那一边）；
 *  2. **时间**：旧账本是分钟桶（`includeOpenMinute` 用来把当前这一分钟算进来），流水是逐笔
 *     秒级，`ts < to` 就是精确的，那个参数因此只当兼容保留；
 *  3. **游标**：旧账本靠 `seen`/`booked`/`cursors` 三张表防重读（吃掉 75–85% 的体积），
 *     这里 `kh` 主键天然幂等，游标只为性能（存在 `meta` 里）。
 *
 * 外机分片仍然照旧：本地流水 + 各机分片 = 合并口径。分片由 `exportShard()` 从**流水**导出，
 * 所以推出去的那份也是去重后的数——Phase 3 会把它换成流水增量。
 */
import { homedir } from 'node:os';

import { UsageStore, STORE_FILE, DETAIL_DAYS } from './store.mjs';
import { Pricing } from './pricing.mjs';
import { gatewayRows, transcriptRows, turnRows, sourcePaths } from './sources.mjs';
import { modelFamily } from './model-families.mjs';

const RETENTION = 8 * 86400;        // 覆盖 7d 窗口并留余量（与旧账本一致）
const SHARD_SCHEMA = 1;
const RETENTION_DAYS = Math.max(DETAIL_DAYS, 8);

export class JournalLedger {
  /**
   * @param opts.file      store.db 路径
   * @param opts.machine   本机 id
   * @param opts.home      原始记录所在家目录
   * @param opts.pricing   Pricing 实例（默认自己建一个）
   * @param opts.scopedGroups 需要单独分桶的档位组（fable 等）
   */
  constructor({ file = STORE_FILE, machine = '', home = homedir(), pricing = null, scopedGroups = [] } = {}) {
    this.machine = machine;
    this.home = home;
    this.pricing = pricing ?? new Pricing();
    this.paths = sourcePaths(home);
    this.store = new UsageStore({ file, machine });
    this.scopedGroups = scopedGroups;
    this.foreignShards = [];
    this.#cursors = this.#loadCursors();
  }

  #cursors;

  #loadCursors() {
    const row = this.store.db.prepare("SELECT v FROM meta WHERE k = 'cursors'").get();
    try { return JSON.parse(row?.v ?? '{}'); } catch { return {}; }
  }

  #saveCursors() {
    this.store.db.prepare("INSERT INTO meta (k,v) VALUES ('cursors',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .run(JSON.stringify(this.#cursors));
  }

  get db() { return this.store.db; }
  get basis() { return this.store.basis; }
  set basis(v) { this.store.basis = v; }

  /** 有支出的分钟桶数——旧账本用同名字段报「账本有多大」，这里是明细+汇总的分钟数。 */
  get bucketCount() {
    const a = this.store.db.prepare('SELECT COUNT(DISTINCT ts / 60) n FROM calls').get().n;
    const b = this.store.db.prepare('SELECT COUNT(DISTINCT hour) n FROM hourly').get().n;
    return a + b;
  }

  /** 需要单独分桶的档位组。空集不覆盖：这一轮读不到 limits ≠ 账号没有档位窗。 */
  adoptScopedGroups(groups) {
    const next = [...new Set((groups ?? []).filter(Boolean).map((g) => String(g).toLowerCase()))];
    if (!next.length) return;
    this.scopedGroups = next;
  }

  /**
   * 扫原始记录写进流水。**幂等**：同一个账目键取较大值，所以重读、重放、停机后补扫都安全。
   * 游标只影响性能——文件被截断就从头读，反正主键会把重复的挡掉。
   * @returns {boolean} 有没有新行（调用方据此决定要不要落盘别的状态）
   */
  refresh(now = Date.now()) {
    const nowSec = Math.floor(now / 1000);
    const cutoff = nowSec - RETENTION;
    let added = 0;
    const batch = [];
    const flush = () => { if (batch.length) { added += this.store.insertCalls(batch); batch.length = 0; } };

    for (const row of transcriptRows({
      root: this.paths.transcripts, cutoff, pricing: this.pricing, machine: this.machine, cursors: this.#cursors,
    })) { batch.push(row); if (batch.length >= 2000) flush(); }
    for (const row of gatewayRows({
      dir: this.paths.gateway, cutoff, pricing: this.pricing, machine: this.machine, cursors: this.#cursors,
    })) { batch.push(row); if (batch.length >= 2000) flush(); }
    flush();

    // 会话轮次（任务归属）跟着一起收：它很小，但文件多（166 个 / 30 MB），靠"变了才读"压住
    const turns = [...turnRows({ dir: this.paths.sessions, cutoff, cursors: this.#cursors })].filter((t) => t.task);
    if (turns.length) this.store.insertTurns(turns);

    this.#saveCursors();     // sources 在读文件时顺手更新了 this.#cursors（只影响性能）
    this.#prune();
    if (added > 0) this.invalidate();   // 新行进来了，内存索引作废（下次查询重建）
    return added > 0;
  }

  /** 明细过期就汇进 hourly 再删（先汇总后删，顺序不可反）。 */
  #prune() {
    this.store.prune({ keepDetailDays: RETENTION_DAYS });
  }

  // MARK: 流水增量（hub 通道：账号级对账与任务报表要明细，不能只有聚合分片）

  /**
   * 推给 hub 用的水位：本机已经推上去的最大 ts。缺省（新库）返回 null，调用方从保留窗起点开始。
   * 存 meta 里，重启不丢——否则每次重启都把 8 天流水重推一遍（幂等，但白费带宽）。
   */
  journalWatermark() {
    const v = this.store.db.prepare("SELECT v FROM meta WHERE k = 'journal_pushed_to'").get()?.v;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  setJournalWatermark(ts) {
    this.store.db.prepare("INSERT INTO meta (k,v) VALUES ('journal_pushed_to',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .run(String(Math.floor(ts)));
  }

  /**
   * 取 `sinceSec` 之后的流水行，按 ts 升序、一批 `limit` 行。
   *
   * 推的是**行**不是聚合：hub 那边因此能出全账号的任务级报表与逐点对账，而不只是三张卡的汇总数。
   * 行里带 `kh`（账目键哈希的字符串形式）当去重身份——**必须 setReadBigInts**：63 位整数按
   * Number 读会抛 ERR_OUT_OF_RANGE（2026-09-23 实测）。
   */
  journalSince(sinceSec, { limit = 2000 } = {}) {
    const st = this.store.db.prepare(`SELECT c.kh, c.ts, c.src, c.side, c.i, c.o, c.cr, c.cw, c.usd,
        c.priced, c.billable, d.name model, s.name sid, w.name ws, e.name effort, m.name machine
      FROM calls c
      JOIN dims d ON d.id = c.model
      JOIN dims m ON m.id = c.machine
      LEFT JOIN dims s ON s.id = c.sess
      LEFT JOIN dims w ON w.id = c.ws
      LEFT JOIN dims e ON e.id = c.effort
      WHERE c.ts >= ? ORDER BY c.ts LIMIT ?`);
    st.setReadBigInts(true);
    return st.all(Math.floor(sinceSec), Math.floor(limit)).map((r) => ({
      // `kh` 只能走字符串（63 位，Number 装不下）；其余整型列**必须显式转回 Number**——
      // setReadBigInts 是整条语句级别的，ts/i/o/… 也会跟着变成 BigInt，而 BigInt 进不了 JSON
      // （2026-09-23 上线时实咬：`Do not know how to serialize a BigInt`，流水一条都推不上去）。
      kh: String(r.kh),
      ts: Number(r.ts), i: Number(r.i), o: Number(r.o), cr: Number(r.cr), cw: Number(r.cw),
      usd: Number(r.usd), priced: Number(r.priced), billable: Number(r.billable),
      src: r.src, side: r.side, model: r.model,
      sid: r.sid ?? null, ws: r.ws ?? null, effort: r.effort ?? null, machine: r.machine,
    }));
  }

  // MARK: 外机分片（Phase 3 会换成流水增量，这里先保持旧协议不变）

  adoptForeignShards(shards) {
    this.foreignShards = (Array.isArray(shards) ? shards : []).filter((s) => s && s.machineId);
    this.invalidate();      // 合并口径变了，索引要重建
  }

  foreignCoverage(nowSec = Date.now() / 1000) {
    return this.foreignShards
      .filter((s) => nowSec - (s.generatedAt ?? 0) <= RETENTION)
      .map((s) => ({
        machineId: s.machineId,
        fromSec: s.coverage?.fromSec ?? Infinity,
        toSec: s.coverage?.toSec ?? -Infinity,
        generatedAt: s.generatedAt,
      }));
  }

  /** 还在推旧口径分片的机器：桶里有美元却没有按模型分桶（v3 之前的分片）。 */
  staleForeignShards() {
    return this.foreignShards
      .filter((s) => Object.keys(s.buckets ?? {}).length > 0 && Object.keys(s.models ?? {}).length === 0)
      .map((s) => s.machineId);
  }

  /** 本机账本导出成分片（从**流水**导，所以推出去的是去重后的数）。 */
  exportShard(machineId = this.machine, nowSec = Date.now() / 1000, identity = {}) {
    const from = nowSec - RETENTION;
    const out = {
      schemaVersion: SHARD_SCHEMA, machineId, generatedAt: nowSec,
      coverage: { fromSec: from, toSec: nowSec },
      ...(identity.account ? { account: identity.account } : {}),
      ...(identity.installId ? { installId: identity.installId } : {}),
      buckets: {}, scoped: {}, models: {}, family: {}, unpriced: {},
    };
    const bump = (o, k, v) => { o[k] = (o[k] ?? 0) + v; };
    // 走 effective：分片带的是这个口径下的数，不是两个来源相加
    const rows = this.store.db.prepare(`SELECT e.ts, d.name model, e.usd, e.src
      FROM effective e JOIN dims d ON d.id = e.model
      WHERE e.machine = (SELECT id FROM dims WHERE kind = 'machine' AND name = ?) AND e.ts >= ?`).all(machineId, from);
    for (const r of rows) {
      if (!(r.usd > 0)) continue;
      const minute = Math.floor(r.ts / 60);
      bump(out.buckets, String(minute), r.usd);
      bump(out.models, `${r.model}|${minute}`, r.usd);
      const lower = String(r.model).toLowerCase();
      for (const g of this.scopedGroups) if (lower.includes(g)) bump(out.scoped, `${g}|${minute}`, r.usd);
      bump(out.family, `${r.src === 'd' ? 'dispatch' : modelFamily(r.model).id}|${minute}`, r.usd);
    }
    // 没价的调用按 (模型, 分钟) 汇总 token——旧分片也是这个形状，读的一端不用改
    for (const r of this.store.db.prepare(`SELECT d.name model, c.ts / 60 minute, SUM(c.i + c.o) tokens
      FROM calls c JOIN dims d ON d.id = c.model
      WHERE c.priced = 0 AND c.billable = 1 AND c.ts >= ?
        AND c.machine = (SELECT id FROM dims WHERE kind = 'machine' AND name = ?)
      GROUP BY c.model, minute`).all(from, machineId)) {
      if (r.tokens > 0) bump(out.unpriced, `${r.model}|${r.minute}`, r.tokens);
    }
    return out;
  }

  // MARK: 查询（本地流水 + 外机分片 = 合并口径）
  //
  // **为什么要有内存前缀和**：旧账本的 `spent()` 是内存里前缀和相减，微秒级；而标定
  // `Calibrator.estimate()` 会**每一对相邻样本问一次**（实测 657 次），`#fullOf` 每帧还要
  // 对四个窗口各问一次。直接把每次 `spent()` 换成一条 SQL（7.5 ms）会让一帧 payload 变成
  // **20 秒**——应用装上新引擎后卡死就是这么来的（2026-09-23 实咬）。
  // 所以这里把索引搭回旧账本的形状：一次聚合查询建好，写入了就作废重建，查询是前缀和相减。

  #index = null;

  /** 建索引：一次查询拿 (分钟, 模型) 的美元，再折成总额/按模型/按家族/按档位组四张前缀和。 */
  #build() {
    const total = new Map();
    const models = new Map();
    const families = new Map();
    const groups = new Map();
    const bump = (m, key, minute, usd) => {
      let t = m.get(key);
      if (!t) { t = new Map(); m.set(key, t); }
      t.set(minute, (t.get(minute) ?? 0) + usd);
    };
    const fold = (model, minute, usd) => {
      total.set(minute, (total.get(minute) ?? 0) + usd);
      bump(models, model, minute, usd);
      bump(families, modelFamily(model).id, minute, usd);
      const lower = String(model).toLowerCase();
      for (const g of this.scopedGroups) if (lower.includes(g)) bump(groups, g, minute, usd);
    };
    for (const r of this.store.db.prepare(`SELECT e.ts / 60 minute, d.name model, SUM(e.usd) usd
      FROM effective e JOIN dims d ON d.id = e.model GROUP BY minute, d.name`).all()) {
      fold(r.model, r.minute, r.usd);
    }
    // 外机分片折进同一套索引（合并口径）。分片的键是「模型|分钟」/「组|分钟」这种。
    for (const s of this.foreignShards) {
      const walk = (obj, kind) => {
        for (const [k, v] of Object.entries(obj ?? {})) {
          const usd = Number(v) || 0;
          if (!usd) continue;
          if (kind === 'buckets') { const m = Number(k); if (Number.isFinite(m)) total.set(m, (total.get(m) ?? 0) + usd); continue; }
          const cut = k.lastIndexOf('|');
          const minute = Number(k.slice(cut + 1));
          if (!Number.isFinite(minute)) continue;
          const name = k.slice(0, cut);
          if (kind === 'models') bump(models, name, minute, usd);
          else if (kind === 'family') bump(families, name, minute, usd);
          else bump(groups, name, minute, usd);
        }
      };
      walk(s.buckets, 'buckets'); walk(s.models, 'models'); walk(s.family, 'family'); walk(s.scoped, 'scoped');
    }
    const table = (map) => {
      const minutes = [...map.keys()].sort((a, b) => a - b);
      const prefix = [0];
      for (const m of minutes) prefix.push(prefix[prefix.length - 1] + map.get(m));
      return { minutes, prefix };
    };
    this.#index = {
      total: table(total),
      models: new Map([...models].map(([k, v]) => [k, table(v)])),
      families: new Map([...families].map(([k, v]) => [k, table(v)])),
      groups: new Map([...groups].map(([k, v]) => [k, table(v)])),
    };
  }

  #tables() { if (!this.#index) this.#build(); return this.#index; }

  /** 内存索引作废（写入了新行、换了分片）。下一次查询重建。 */
  invalidate() { this.#index = null; }

  /** 半开区间内的等价支出。`includeOpenMinute` 只作兼容保留：流水是秒级，`ts < to` 本就精确。 */
  spent(fromSec, toSec, { group = null, model = null } = {}) {
    const idx = this.#tables();
    const t = group ? idx.groups.get(String(group).toLowerCase())
      : model ? idx.models.get(String(model))
        : idx.total;
    if (!t || !t.minutes.length) return 0;
    const lo = lowerBound(t.minutes, Math.floor(fromSec / 60));
    const hi = lowerBound(t.minutes, Math.floor(toSec / 60) + 1);
    return t.prefix[hi] - t.prefix[lo];
  }

  /** 区间内有支出的分钟数（合并口径：同一分钟多台机器只算一次）。 */
  activeMinutes(fromSec, toSec, { group = null } = {}) {
    const idx = this.#tables();
    const t = group ? idx.groups.get(String(group).toLowerCase()) : idx.total;
    if (!t || !t.minutes.length) return 0;
    const lo = lowerBound(t.minutes, Math.floor(fromSec / 60));
    const hi = lowerBound(t.minutes, Math.floor(toSec / 60) + 1);
    return Math.max(0, hi - lo);
  }

  familyIds() { return [...this.#tables().families.keys()].filter(Boolean); }

  familySpent(fromSec, toSec, familyId) {
    const t = this.#tables().families.get(String(familyId));
    if (!t || !t.minutes.length) return 0;
    const lo = lowerBound(t.minutes, Math.floor(fromSec / 60));
    const hi = lowerBound(t.minutes, Math.floor(toSec / 60) + 1);
    return t.prefix[hi] - t.prefix[lo];
  }

  /** 各模型累计美元（倍率标定用：点数与美元必须在同一瞬配对）。 */
  cumulativeByModel() {
    const out = {};
    for (const r of this.store.db.prepare(`SELECT d.name model, SUM(c.usd) usd FROM calls c
      JOIN dims d ON d.id = c.model WHERE c.billable = 1 GROUP BY c.model`).all()) {
      out[r.model] = (out[r.model] ?? 0) + r.usd;
    }
    for (const s of this.foreignShards) {
      for (const [k, v] of Object.entries(s.models ?? {})) {
        const model = k.slice(0, k.lastIndexOf('|'));
        out[model] = (out[model] ?? 0) + (Number(v) || 0);
      }
    }
    return out;
  }

  modelIds() {
    const ids = new Set(this.store.db.prepare("SELECT name FROM dims WHERE kind = 'model'").all().map((r) => r.name));
    for (const s of this.foreignShards) {
      for (const k of Object.keys(s.models ?? {})) ids.add(k.slice(0, k.lastIndexOf('|')));
    }
    ids.delete('');
    return [...ids];
  }

  /** 网关记得比 transcript 多的那些模型（对账报警）。 */
  crossSourceGaps(fromSec, toSec, opts = {}) {
    return this.store.reconcile(fromSec, toSec, opts)
      .filter((r) => r.gapWorthReporting)
      .map((r) => ({ model: r.model, transcriptUSD: r.t, gatewayUSD: r.g, ratio: r.ratio }));
  }

  /** 没价的调用（token 记下了、美元算不出）。 */
  unpricedUsage(fromSec, toSec) {
    return this.store.unpriced(fromSec, toSec).map((r) => ({ model: r.model, tokens: r.tokens }));
  }

  /** 按机器拆开的窗口支出（多机页「谁花的」）。 */
  perMachineSpent(fromSec, toSec, { group = null, selfId = null, self = null } = {}) {
    const out = [];
    const me = self ?? { machineId: selfId };
    out.push({
      machineId: me.machineId ?? selfId, self: true, account: me.account ?? null, installId: me.installId ?? null,
      usd: this.store.spend(fromSec, toSec, { machine: me.machineId ?? selfId }).usd,
      groupUSD: group ? this.store.spend(fromSec, toSec, { machine: me.machineId ?? selfId, group }).usd : 0,
    });
    for (const s of this.foreignShards) {
      const head = group ? String(group).toLowerCase() + '|' : null;
      out.push({
        machineId: s.machineId, self: false, account: s.account ?? null, installId: s.installId ?? null,
        usd: shardRangeSum(s.buckets, fromSec, toSec),
        groupUSD: head ? shardRangeSum(s.scoped, fromSec, toSec, head) : 0,
      });
    }
    return out;
  }

  /** 分片里某个字段在区间内的合计。 */
  #shardSum(field, fromSec, toSec, prefix = null) {
    let total = 0;
    for (const s of this.foreignShards) total += shardRangeSum(s[field], fromSec, toSec, prefix);
    return total;
  }

  close() { this.store.close(); }
}

/** 有序数组里第一个 >= x 的下标（前缀和相减用）。 */
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** 分片字典（"分钟" 或 "前缀|分钟" → 美元）在区间内求和。 */
export function shardRangeSum(obj, fromSec, toSec, prefix = null) {
  const lo = Math.floor(fromSec / 60), hi = Math.floor(toSec / 60);
  let total = 0;
  for (const [k, v] of Object.entries(obj ?? {})) {
    const m = Number(prefix ? k.slice(prefix.length) : k);
    if (!Number.isFinite(m) || m < lo || m > hi) continue;
    if (prefix && !k.startsWith(prefix)) continue;
    total += Number(v) || 0;
  }
  return total;
}
