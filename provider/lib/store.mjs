/**
 * 账本存储：SQLite 流水账。
 *
 * 为什么不是 JSON 聚合态（2026-09-22/23 两次实咬）：
 *  1. **聚合态当账本存 ⇒ 换口径必须清空重建**。旧账本把"分钟桶"当唯一真相，于是"美元该听
 *     transcript 还是网关"这个判断被烧进了数据里，改一次就得把 8 天重扫一遍（schema 3 那次）。
 *     这里两份来源都进 `calls`，口径是 `effective` **视图**：换口径 = 换一行 DDL，一个字节都不动。
 *  2. **去重键吃掉 75–85% 的体积**。旧账本用 `seen`/`booked`/`shadowBooked` 三张表防重读，
 *     实测 8 天 1906 KB / 2250 KB。这里账目键的**哈希**就是唯一索引，一条 upsert 同时给出
 *     "去重"与"同一响应多行取较大值"两种语义。
 *  3. **没有任务/会话/工作区维度**，于是"每个任务花了多少"结构上问不出来。`calls` 逐笔带
 *     会话（`sess`）与工作区（`ws`）维度，`turns` 表补上任务归属。
 *
 * 磁盘为什么长这样（2026-09-23 用 dbstat 实测后重排过一版）：
 *   第一版把 `calls` 建成 WITHOUT ROWID、5 个二级索引，实测 **945 字节/行**，其中 67% 是索引——
 *   因为 WITHOUT ROWID 表的每个二级索引项里都嵌着 75 字符的账目键原文。改成本表这样：
 *     · `calls` 用 rowid 表，二级索引只嵌 8 字节 rowid；
 *     · 重复出现的字符串（会话 uuid 36 字符、工作区路径、模型名、机器名、档位）进 `dims` 表，
 *       `calls` 里只留整数 id；
 *     · 去重身份是 63 位哈希 `kh`（唯一索引），**账目键原文不进库**——它平均 75 字符
 *       （网关的 `uuid:uuid`），逐行存就是全库最大的一列；要回溯某笔调用，
 *       按 (机器, 会话, 时刻, 模型) 去原始记录里找，这个四元组是唯一的。
 *     · 二级索引只留 3 个（视图分组 / 会话查询 / 保留裁剪各一个）。
 *   实测：24k 行 5.7 MB → **233 字节/行**（第一版 945）。再往下压就得动"明细留多久"这个旋钮了。
 *
 * 分层（磁盘与保留时间靠这个兼顾）：
 *   calls   逐笔明细，保留 30 天（可配，见 docs/STORE.md 的实测表）。
 *   hourly  小时汇总，**永久**保留。明细删掉后报表照出，且与明细同一个口径（见下）。
 *   points / marks  官方点数采样与同瞬的模型累计，给倍率标定与对账用。
 *   prices / families  价目与家族表（代码里的常量开库时种进来，供 SQL join）。
 *   machines / limits  hub 侧：各机推上来的分片与账号额度快照。
 *
 * 复用点（"月底迁 VPS"就是这三条命令）：
 *   pack()   → `VACUUM INTO` 出一份一致的**单文件**快照（WAL 下别直接拷 .db，会漏 -wal）
 *   inspect()→ 校验快照：schema 版本、integrity、行数、时间跨度
 *   import   → 同一套 `sources.mjs` 读原始记录重建（换机器、换盘、旧数据迁移都走它）
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { BUILTIN, FAMILY, Pricing } from './pricing.mjs';
import { familyLabel, modelFamily } from './model-families.mjs';

/**
 * 库的形状版本。改动 `calls`/`hourly`/`dims` 的列或主键就必须 +1。
 *
 * v2（2026-09-23）：汇总层的主键补上 `side`/`priced`/`billable`——原来少这三列，两个不同的
 * 分组会撞进同一行、后者覆盖前者，而这是"先汇总后删"路径上的静默丢数。
 * v3（2026-09-23）：汇总层由 `daily`（按天）改成 `hourly`（按小时）。按天那版实测在 VPS 上
 * 历史区间比明细层少 $6.87（0.15%）：逐小时取大之和恒 ≥ 先按天求和再取大，按天存等于给自己
 * 留了一个恒偏低的口径偏差，而对账工具不该有偏差。
 *
 * v1/v2 都没发布过，所以旧库直接**重建派生表**（见 `#migrate`）：流水能从原始记录重扫回来。
 * 从 v3 起，任何破坏性改形状都必须先写就地迁移，否则宁可拒绝打开——原始记录不是永远都在
 * （transcript 会被 Claude Code 清掉，那天已经发生过一次）。
 *
 * v3 之后加的 `attrib` / `anchors` 是**加表**，没动 calls/hourly/dims 的列与主键，所以不 +1：
 * DDL 每次开库都跑（`CREATE TABLE IF NOT EXISTS`），旧库自然长出这两张表。
 */
export const STORE_SCHEMA = 3;
export const STORE_FILE = join(homedir(), '.miraquota', 'store.db');
/** 明细默认保留天数。想留更久就调大——磁盘代价见文件头那张实测表。 */
export const DETAIL_DAYS = 30;

/** 口径：这一小时这个模型听谁的。换它不动数据，只换视图。 */
export const BASES = {
  max: '取两边较大的（默认）：谁记得全听谁的，同一小时不相加，不会回到双计',
  t: '只认 transcript：会话文件被清理过的机器会偏低',
  g: '只认网关：不经 relay 的调用会缺',
  union: '两边相加：旧账本的做法，同一笔调用会被记两次',
};

const DDL = `
-- 维度表：字符串只存一次。会话 uuid 36 字符、工作区路径几十字符，逐行重复就是几 MB。
CREATE TABLE IF NOT EXISTS dims (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- session / model / machine / effort / ws
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS dims_uniq ON dims(kind, name);

CREATE TABLE IF NOT EXISTS calls (
  id       INTEGER PRIMARY KEY,
  kh       INTEGER NOT NULL,   -- 账目键的 63 位哈希：去重身份，也是唯一索引
  src      TEXT NOT NULL,      -- t=transcript g=网关 d=dispatch
  side     TEXT NOT NULL,      -- t / g：去重时算哪一边（dispatch 归 g）
  ts       INTEGER NOT NULL,
  hour     INTEGER NOT NULL,
  day      INTEGER NOT NULL,   -- YYYYMMDD 整数（10 字符字符串换成 4 字节）
  sess     INTEGER NOT NULL DEFAULT 0,
  model    INTEGER NOT NULL DEFAULT 0,
  machine  INTEGER NOT NULL DEFAULT 0,
  effort   INTEGER NOT NULL DEFAULT 0,
  ws       INTEGER NOT NULL DEFAULT 0,
  i        INTEGER NOT NULL DEFAULT 0,
  o        INTEGER NOT NULL DEFAULT 0,
  cr       INTEGER NOT NULL DEFAULT 0,
  cw       INTEGER NOT NULL DEFAULT 0,
  usd      REAL NOT NULL DEFAULT 0,
  priced   INTEGER NOT NULL DEFAULT 1,  -- 0 = 价目表没这个模型，usd 不可信
  billable INTEGER NOT NULL DEFAULT 1   -- 0 = 没走 relay，不计入账号花费
);
CREATE UNIQUE INDEX IF NOT EXISTS calls_kh ON calls(kh);
CREATE INDEX IF NOT EXISTS calls_hour ON calls(machine, hour, model, side);
CREATE INDEX IF NOT EXISTS calls_sess ON calls(sess, ts);
CREATE INDEX IF NOT EXISTS calls_day ON calls(day);

-- 汇总层：明细删掉之后报表还出得来。**按小时存**，于是口径（逐小时逐模型取大）与明细层
-- 完全一致——按天存过一次，实测 VPS 上历史区间比明细层少 $6.87（0.15%）：逐小时取大之和
-- 恒 ≥ 先按天求和再取大，按天存等于给自己留了一个恒偏低的口径偏差，对账工具不该有。
-- 代价只是行数多几倍（实测 90 天约 1 MB），换"历史与当下同一个口径"值得。
-- 主键必须覆盖汇总的每一个分组列（含 side/priced/billable）：少一列，两个不同的组就会撞进
-- 同一行、后者覆盖前者，而这是"先汇总后删"路径上的静默丢数（2026-09-23 补）。
CREATE TABLE IF NOT EXISTS hourly (
  hour INTEGER NOT NULL, day INTEGER NOT NULL,
  machine INTEGER NOT NULL DEFAULT 0, model INTEGER NOT NULL DEFAULT 0,
  sess INTEGER NOT NULL DEFAULT 0, ws INTEGER NOT NULL DEFAULT 0,
  src TEXT NOT NULL, side TEXT NOT NULL, priced INTEGER NOT NULL, billable INTEGER NOT NULL,
  usd REAL NOT NULL DEFAULT 0, i INTEGER NOT NULL DEFAULT 0, o INTEGER NOT NULL DEFAULT 0,
  cr INTEGER NOT NULL DEFAULT 0, cw INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, machine, model, sess, ws, src, side, priced, billable)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS hourly_day ON hourly(day);

-- 会话轮次（Mirasim 的会话库）：只用来**归属**任务，不当作花费来源——它的 usage 没有缓存写，
-- 而缓存读/写占 fable 花费的一半以上；当来源会与 transcript 重复计。
CREATE TABLE IF NOT EXISTS turns (
  task TEXT NOT NULL, sid TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
  model TEXT, prompt_head TEXT, i INTEGER, o INTEGER, cr INTEGER,
  PRIMARY KEY (task, sid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS turns_span ON turns(sid, started_at, ended_at);

CREATE TABLE IF NOT EXISTS points (
  label TEXT NOT NULL, at INTEGER NOT NULL, used REAL NOT NULL,
  budget REAL NOT NULL, reset_at INTEGER, PRIMARY KEY (label, at)
) WITHOUT ROWID;

-- 同一个 tick 上各模型的**累计**美元。存累计而不是增量：增量依赖"上一条 mark 存在"，
-- 而采样会跳 tick（值没变就不记），累计相减与 tick 是否连续无关。
-- broken=1 表示这一行的累计与上一行不可比（桶被修剪、重启换了基准），跨它的区间必须丢掉。
CREATE TABLE IF NOT EXISTS marks (
  at INTEGER NOT NULL, model TEXT NOT NULL, cum REAL NOT NULL,
  broken INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (at, model)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS prices (
  id TEXT PRIMARY KEY, input REAL, output REAL, cache_read REAL, cache_write REAL, source TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS families (
  match TEXT PRIMARY KEY, family TEXT NOT NULL, label TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS machines (
  machine TEXT PRIMARY KEY, last_shard_at INTEGER, coverage_from INTEGER, coverage_to INTEGER,
  received_at INTEGER, payload TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS limits (
  id INTEGER PRIMARY KEY CHECK (id = 1), captured_at INTEGER, machine TEXT, payload TEXT
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;

-- 点数归因：官方点数增量按同期各家族账本美元占比分摊的结果。以前是 points-attrib.json
-- （本机 74 KB），现在跟流水同一个库。
CREATE TABLE IF NOT EXISTS attrib (
  family TEXT NOT NULL, minute INTEGER NOT NULL, points REAL NOT NULL,
  PRIMARY KEY (family, minute)
) WITHOUT ROWID;

-- 窗口锚点：离线推算的依据（最后一次实测的窗口边界、百分比与满额）。**整组替换**——
-- 它是一组快照而不是累积量，所以没有 upsert 语义，写的时候按 (label, reset_at) 覆盖。
CREATE TABLE IF NOT EXISTS anchors (
  label TEXT NOT NULL, reset_at INTEGER NOT NULL, duration INTEGER,
  captured_at INTEGER, used_percent REAL, budget REAL, used REAL, model_scoped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (label, reset_at)
) WITHOUT ROWID;
`;

/** 视图：把"这一小时听谁的"写在一处。所有查询都走它，于是口径是查询时的事。 */
function viewSql(basis) {
  if (basis === 't') return `CREATE VIEW effective AS SELECT * FROM calls WHERE billable = 1 AND side = 't'`;
  if (basis === 'g') return `CREATE VIEW effective AS SELECT * FROM calls WHERE billable = 1 AND side = 'g'`;
  if (basis === 'union') return `CREATE VIEW effective AS SELECT * FROM calls WHERE billable = 1`;
  // max：每个 (机器, 模型, 小时) 里两边的合计比大小，只留大的那一边的全部行。
  // 同一小时不相加 ⇒ 同一笔调用被两边都记下时不会翻倍；一边缺记录时另一边顶上。
  return `CREATE VIEW effective AS
    SELECT c.* FROM calls c
    JOIN (
      SELECT machine, model, hour, side FROM (
        SELECT machine, model, hour, side, SUM(usd) s,
               ROW_NUMBER() OVER (PARTITION BY machine, model, hour ORDER BY SUM(usd) DESC, side) rn
        FROM calls WHERE billable = 1 GROUP BY machine, model, hour, side
      ) WHERE rn = 1
    ) p ON p.machine = c.machine AND p.model = c.model AND p.hour = c.hour AND p.side = c.side
    WHERE c.billable = 1`;
}

/** 账目键 → 63 位哈希（放进有符号 64 位整数里不溢出）。200k 行时碰撞概率 ~2e-9。 */
export function keyHash(key) {
  const h = createHash('sha1').update(String(key)).digest();
  return BigInt('0x' + h.subarray(0, 8).toString('hex')) & 0x7fffffffffffffffn;
}

/** YYYYMMDD 整数（比 'YYYY-MM-DD' 字符串省 6 字节，且排序与比较都一致）。 */
const dayInt = (ts) => {
  const d = new Date(ts * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};
const dayStr = (n) => `${String(Math.floor(n / 10000)).padStart(4, '0')}-${String(Math.floor(n / 100) % 100).padStart(2, '0')}-${String(n % 100).padStart(2, '0')}`;

export class UsageStore {
  /**
   * @param opts.file    库文件路径（默认 ~/.miraquota/store.db）
   * @param opts.basis   口径，见 BASES；存在 meta 里，换口径只改视图
   * @param opts.machine 本机 id，写进每一行（维度表里存字符串，calls 里存 id）
   */
  constructor({ file = STORE_FILE, basis = 'max', machine = '' } = {}) {
    this.file = file;
    this.machine = machine;
    this.#dimCache = new Map();
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(DDL);
    this.#migrate();
    this.#seedPrices();
    this.basis = basis;
  }

  #dimCache;

  #migrate() {
    const cur = this.db.prepare('PRAGMA user_version').get().user_version ?? 0;
    if (cur > STORE_SCHEMA) {
      throw new Error(`store.db 的 schema 是 ${cur}，本版只认到 ${STORE_SCHEMA}——升级程序或换文件，别降级读`);
    }
    if (cur === STORE_SCHEMA) return;
    if (cur > 0) {
      // 派生表（dims/calls/hourly）能从原始记录重建，所以旧版本就地重建；`meta`（口径等）留着。
      // 这只在 v1→v2 这次成立——v1 从未发布，且它只是我本机的中间形状。以后要破坏性改形状，
      // 必须先写就地迁移（契约 #6）：流水一旦成了唯一副本（原始记录被清理），重建就等于丢账。
      console.warn(`[store] schema ${cur} → ${STORE_SCHEMA}：重建派生表（原始记录还在，跑一次 --import 即可）`);
      this.db.exec('DROP VIEW IF EXISTS effective');
      this.db.exec('DROP TABLE IF EXISTS calls');
      this.db.exec('DROP TABLE IF EXISTS daily');
      this.db.exec('DROP TABLE IF EXISTS hourly');
      this.db.exec('DROP TABLE IF EXISTS dims');
      this.db.exec(DDL);
      this.db.prepare("INSERT INTO meta (k,v) VALUES ('rebuild_needed','1') ON CONFLICT(k) DO UPDATE SET v='1'").run();
    }
    this.db.exec(`PRAGMA user_version = ${STORE_SCHEMA}`);
  }

  /** 上一次开库是否重建过派生表（还没重新导入）。CLI 据此提示，避免拿空库出报表。 */
  get needsImport() { return this.db.prepare("SELECT v FROM meta WHERE k='rebuild_needed'").get()?.v === '1'; }
  clearNeedsImport() {
    this.db.prepare("DELETE FROM meta WHERE k='rebuild_needed'").run();
  }

  /** 价目与家族常量种进库里，供 SQL join（代码仍是唯一来源，每次开库覆盖）。 */
  #seedPrices() {
    const ins = this.db.prepare('INSERT INTO prices (id,input,output,cache_read,cache_write,source) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET input=excluded.input, output=excluded.output, cache_read=excluded.cache_read, cache_write=excluded.cache_write, source=excluded.source');
    this.db.exec('BEGIN');
    try {
      for (const [id, [i, o, cr, cw]] of Object.entries(BUILTIN)) ins.run(id, i, o, cr, cw, 'builtin');
      const fam = this.db.prepare('INSERT INTO families (match,family,label) VALUES (?,?,?) ON CONFLICT(match) DO UPDATE SET family=excluded.family, label=excluded.label');
      for (const [match, key] of FAMILY) {
        const f = modelFamily(key);          // 家族 id 从"兜底落到哪个模型"推出来，与账本里的 family 同一个口径
        fam.run(match, f.id, familyLabel(f.id) ?? f.label);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** 维度名 → id（不在就插）。同一进程内缓存，逐行调用也不至于每次查库。 */
  dimId(kind, name) {
    const key = kind + '\u0000' + (name ?? '');
    const hit = this.#dimCache.get(key);
    if (hit != null) return hit;
    const row = this.db.prepare('SELECT id FROM dims WHERE kind = ? AND name = ?').get(kind, String(name ?? ''));
    let id = row?.id;
    if (id == null) {
      this.db.prepare('INSERT INTO dims (kind,name) VALUES (?,?) ON CONFLICT(kind,name) DO NOTHING').run(kind, String(name ?? ''));
      id = this.db.prepare('SELECT id FROM dims WHERE kind = ? AND name = ?').get(kind, String(name ?? '')).id;
    }
    this.#dimCache.set(key, id);
    return id;
  }

  get basis() { return this.db.prepare("SELECT v FROM meta WHERE k='basis'").get()?.v ?? 'max'; }
  set basis(v) {
    if (!BASES[v]) throw new Error(`不认识的口径 ${v}，可选：${Object.keys(BASES).join(' / ')}`);
    this.db.exec('DROP VIEW IF EXISTS effective');
    this.db.exec(viewSql(v));
    this.db.prepare("INSERT INTO meta (k,v) VALUES ('basis',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(v);
  }

  setMachine(id) { this.machine = id ?? ''; return this; }

  // MARK: 写入

  /**
   * 写一批流水行。同一个账目键再来一次取较大值——transcript 的一次响应写成多行、网关的回填
   * 都会让同一笔的 token 变大，取大即是"这一笔到底花了多少"。
   * 重复读同一个文件因此是幂等的：**游标只影响性能，不影响正确性**。
   * @returns {number} 真正新插入的行数（已存在的不算）
   */
  insertCalls(rows) {
    const ins = this.db.prepare(`INSERT INTO calls
      (kh,src,side,ts,hour,day,sess,model,machine,effort,ws,i,o,cr,cw,usd,priced,billable)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(kh) DO UPDATE SET
        usd=MAX(usd,excluded.usd), i=MAX(i,excluded.i), o=MAX(o,excluded.o),
        cr=MAX(cr,excluded.cr), cw=MAX(cw,excluded.cw),
        effort=CASE WHEN excluded.effort=0 THEN effort ELSE excluded.effort END,
        sess=CASE WHEN excluded.sess=0 THEN sess ELSE excluded.sess END,
        ws=CASE WHEN excluded.ws=0 THEN ws ELSE excluded.ws END`);
    const has = this.db.prepare('SELECT 1 FROM calls WHERE kh = ?');
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const ts = Math.floor(r.ts);
        // 带 `kh` 的行来自别的机器（hub 收流水增量）：那边算好哈希了，直接用字符串传过来
        // （63 位整数超过 Number.MAX_SAFE_INTEGER，读回会抛 ERR_OUT_OF_RANGE，所以一律走 BigInt）。
        const kh = r.kh != null ? BigInt(r.kh) : keyHash(r.key);
        const fresh = has.get(kh) == null;
        ins.run(
          kh, r.src, r.side ?? (r.src === 't' ? 't' : 'g'), ts, Math.floor(ts / 3600), dayInt(ts),
          r.sid ? this.dimId('session', r.sid) : 0,
          // 模型名归一化（剥掉 `[1m]` 这类上下文后缀）：`claude-opus-5[1m]` 与 `claude-opus-5`
          // 是同一个模型同一份价，进同一个维度，否则报表里会分裂成两行（旧账本同样归一化）。
          r.model ? this.dimId('model', Pricing.normalize(r.model)) : 0,
          this.dimId('machine', r.machine ?? this.machine),
          r.effort ? this.dimId('effort', r.effort) : 0,
          r.ws ? this.dimId('ws', r.ws) : 0,
          Math.round(r.i ?? 0), Math.round(r.o ?? 0), Math.round(r.cr ?? 0), Math.round(r.cw ?? 0),
          // 这两个在流水里是「有没有价 / 算不算钱」的开关，布尔与 0/1 都得收：hub 的 /journal
          // 收的是**网络上来**的行，而 node:sqlite 绑不了 JS 布尔（参数绑定会直接抛）。
          r.usd ?? 0, r.priced === false ? 0 : (r.priced == null ? 1 : Number(r.priced) ? 1 : 0),
          r.billable === false ? 0 : (r.billable == null ? 1 : Number(r.billable) ? 1 : 0),
        );
        if (fresh) added++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return added;
  }

  /** 官方点数采样（30 秒一采）。 */
  insertPoints(rows) {
    const ins = this.db.prepare('INSERT INTO points (label,at,used,budget,reset_at) VALUES (?,?,?,?,?) ON CONFLICT(label,at) DO UPDATE SET used=excluded.used, budget=excluded.budget, reset_at=excluded.reset_at');
    this.db.exec('BEGIN');
    try {
      for (const p of rows) ins.run(p.label, Math.floor(p.at), p.used, p.budget ?? 0, p.resetAt ?? null);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return rows.length;
  }

  /**
   * 同一个 tick 上的各模型累计美元（倍率标定用）。
   * @param broken 这一 tick 的基准断了（修剪/重启）：该 tick 之前的累计与之后不可比
   */
  insertMarks(at, cumulative, { broken = false } = {}) {
    const ins = this.db.prepare('INSERT INTO marks (at,model,cum,broken) VALUES (?,?,?,?) ON CONFLICT(at,model) DO UPDATE SET cum=excluded.cum, broken=excluded.broken');
    const t = Math.floor(at);
    this.db.exec('BEGIN');
    try {
      for (const [model, cum] of Object.entries(cumulative ?? {})) ins.run(t, model, cum, broken ? 1 : 0);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** 某个模型在 [from, to] 内可用的累计读数（跨 broken 的区间由调用方丢掉）。 */
  markSeries(model, fromSec, toSec) {
    return this.db.prepare('SELECT at, cum, broken FROM marks WHERE model = ? AND at >= ? AND at <= ? ORDER BY at')
      .all(String(model), Math.floor(fromSec), Math.floor(toSec));
  }

  // MARK: 点数归因与锚点（Phase 2b 余下：这两个从前各写一个 JSON 文件）

  /**
   * 归因桶（家族|分钟 → 点数）。**累加由调用方算好**——这里只写最终值，
   * 因为分摊要按同期的家族美元占比一次算完，不是逐笔 upsert。
   */
  insertAttrib(rows) {
    if (!rows?.length) return 0;
    const ins = this.db.prepare('INSERT INTO attrib (family,minute,points) VALUES (?,?,?) ON CONFLICT(family,minute) DO UPDATE SET points=excluded.points');
    this.db.exec('BEGIN');
    try {
      for (const r of rows) ins.run(String(r.family), Math.floor(r.minute), r.points);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return rows.length;
  }

  /** 区间内每个家族的归因点数（分钟粒度，半开区间）。 */
  attribRange(fromSec, toSec) {
    return this.db.prepare(`SELECT family, SUM(points) points FROM attrib
      WHERE minute >= ? AND minute <= ? GROUP BY family`)
      .all(Math.floor(fromSec / 60), Math.floor(toSec / 60))
      .map((r) => ({ family: r.family, points: r.points }));
  }

  pruneAttrib(cutoffMinute) {
    return this.db.prepare('DELETE FROM attrib WHERE minute < ?').run(Math.floor(cutoffMinute)).changes;
  }

  /** 锚点是一组快照：整组替换，不做累积（同一 (label, reset_at) 覆盖）。 */
  putAnchors(anchors, capturedAt) {
    const ins = this.db.prepare(`INSERT INTO anchors
      (label,reset_at,duration,captured_at,used_percent,budget,used,model_scoped) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(label,reset_at) DO UPDATE SET duration=excluded.duration, captured_at=excluded.captured_at,
        used_percent=excluded.used_percent, budget=excluded.budget, used=excluded.used, model_scoped=excluded.model_scoped`);
    this.db.exec('BEGIN');
    try {
      // 换了一批窗口（重置时刻变了）就把旧窗口清掉：锚点只对**当前这一组**有意义，
      // 留着旧的重置时刻会让离线推算在窗口换代后挑错行。
      this.db.exec('DELETE FROM anchors');
      for (const a of anchors ?? []) {
        ins.run(String(a.label), Math.floor(a.resetAt), a.duration ?? null, Math.floor(a.capturedAt ?? capturedAt ?? 0),
          a.usedPercent ?? null, a.budget ?? null, a.used ?? null, a.modelScoped ? 1 : 0);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.metaSet('anchors_captured_at', String(Math.floor(capturedAt ?? 0)));
    return (anchors ?? []).length;
  }

  readAnchors() {
    return this.db.prepare(`SELECT label,reset_at,duration,captured_at,used_percent,budget,used,model_scoped
      FROM anchors ORDER BY label`).all().map((r) => ({
      label: r.label, resetAt: r.reset_at, duration: r.duration, capturedAt: r.captured_at,
      usedPercent: r.used_percent, budget: r.budget, used: r.used, modelScoped: !!r.model_scoped,
    }));
  }

  /** meta 里的标量（游标、口径、归因的小状态）。批量读一次省得逐条查。 */
  metaGet(k) { return this.db.prepare('SELECT v FROM meta WHERE k = ?').get(String(k))?.v ?? null; }

  metaSet(k, v) {
    this.db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run(String(k), String(v));
  }

  /** 会话轮次（任务归属用）。 */
  insertTurns(rows) {
    const ins = this.db.prepare('INSERT INTO turns (task,sid,started_at,ended_at,model,prompt_head,i,o,cr) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(task,sid) DO UPDATE SET ended_at=MAX(ended_at,excluded.ended_at), model=COALESCE(excluded.model,model), i=MAX(i,excluded.i), o=MAX(o,excluded.o), cr=MAX(cr,excluded.cr)');
    this.db.exec('BEGIN');
    try {
      for (const t of rows) ins.run(t.task, t.sid, Math.floor(t.startedAt), Math.floor(t.endedAt), t.model ?? null, t.promptHead ?? null, t.i ?? 0, t.o ?? 0, t.cr ?? 0);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return rows.length;
  }

  // MARK: 查询（全部走 effective 视图；维度名按需 join 回来）

  /** 窗口内生效口径的总美元。 */
  spend(fromSec, toSec, opts = {}) {
    const { where, params } = this.#filters(opts, 'e');
    const join = opts.task ? 'JOIN turns t ON t.sid = (SELECT name FROM dims WHERE id = e.sess) AND e.ts >= t.started_at AND e.ts <= t.ended_at' : '';
    const extra = opts.task ? ' AND t.task = ?' : '';
    const p = opts.task ? [...params, String(opts.task)] : params;
    const row = this.db.prepare(`SELECT COALESCE(SUM(e.usd),0) usd, COUNT(*) n FROM effective e ${join}
      ${where} AND e.ts >= ? AND e.ts < ?${extra}`).get(...p, Math.floor(fromSec), Math.floor(toSec));
    return { usd: row.usd, calls: row.n };
  }

  /** 窗口内按模型拆开（倍率对账、模型报表用）。 */
  byModel(fromSec, toSec, opts = {}) {
    const { where, params } = this.#filters(opts, 'e');
    return this.db.prepare(`SELECT d.name model, SUM(e.usd) usd, COUNT(*) n,
      SUM(e.i) i, SUM(e.o) o, SUM(e.cr) cr, SUM(e.cw) cw
      FROM effective e JOIN dims d ON d.id = e.model
      ${where} AND e.ts >= ? AND e.ts < ? GROUP BY e.model ORDER BY usd DESC`)
      .all(...params, Math.floor(fromSec), Math.floor(toSec))
      .map((r) => ({ ...r, family: familyOf(r.model) }));
  }

  /** 窗口内按来源拆开——对账要看的是"两边各记了多少"。 */
  bySource(fromSec, toSec, opts = {}) {
    const { where, params } = this.#filters(opts, 'c');
    return this.db.prepare(`SELECT c.src, c.side, SUM(c.usd) usd, COUNT(*) n FROM calls c ${where}
      AND c.ts >= ? AND c.ts < ? AND c.billable = 1 GROUP BY c.src, c.side ORDER BY usd DESC`)
      .all(...params, Math.floor(fromSec), Math.floor(toSec));
  }

  /** 按会话（任务归属的兜底维度，全覆盖）。 */
  bySession(fromSec, toSec, opts = {}) {
    const { where, params } = this.#filters(opts, 'e');
    return this.db.prepare(`SELECT s.name sid, m.name machine, w.name ws, SUM(e.usd) usd, COUNT(*) n,
      MIN(e.ts) first_at, MAX(e.ts) last_at, GROUP_CONCAT(DISTINCT d.name) models
      FROM effective e
      JOIN dims s ON s.id = e.sess JOIN dims m ON m.id = e.machine
      LEFT JOIN dims w ON w.id = e.ws JOIN dims d ON d.id = e.model
      ${where} AND e.ts >= ? AND e.ts < ? GROUP BY e.sess, e.machine ORDER BY usd DESC`)
      .all(...params, Math.floor(fromSec), Math.floor(toSec));
  }

  /**
   * 按任务（Mirasim 的 taskId，按 [startedAt, updatedAt] 时间区间归属）。
   * 归不上的部分单独给出来——轮次只覆盖 Mirasim 管起来的会话，摊到别的任务头上就是编数。
   */
  byTask(fromSec, toSec, opts = {}) {
    const { where, params } = this.#filters(opts, 'e');
    const rows = this.db.prepare(`SELECT t.task, s.name sid, t.model turn_model, SUM(e.usd) usd, COUNT(*) n,
      MIN(e.ts) first_at, MAX(e.ts) last_at
      FROM effective e JOIN dims s ON s.id = e.sess
      JOIN turns t ON t.sid = s.name AND e.ts >= t.started_at AND e.ts <= t.ended_at
      ${where} AND e.ts >= ? AND e.ts < ?
      GROUP BY t.task, e.sess, t.model ORDER BY usd DESC`)
      .all(...params, Math.floor(fromSec), Math.floor(toSec));
    const total = this.spend(fromSec, toSec, opts);
    const claimed = rows.reduce((s, r) => s + r.usd, 0);
    return { rows, claimed, total: total.usd, unclaimed: total.usd - claimed };
  }

  /** 按工作区/仓库（网关行里现成有 workspace/repo）。 */
  byWorkspace(fromSec, toSec, opts = {}) {
    const { where, params } = this.#filters(opts, 'e');
    return this.db.prepare(`SELECT CASE WHEN w.name IS NULL THEN '(未记)' ELSE w.name END ws,
      SUM(e.usd) usd, COUNT(*) n, COUNT(DISTINCT e.sess) sessions
      FROM effective e LEFT JOIN dims w ON w.id = e.ws
      ${where} AND e.ts >= ? AND e.ts < ? GROUP BY e.ws ORDER BY usd DESC`)
      .all(...params, Math.floor(fromSec), Math.floor(toSec));
  }

  /** 按天（明细删掉之后走 hourly 汇总表，见 totalWithDaily）。 */
  byDay(fromSec, toSec, opts = {}) {
    const { where, params } = this.#filters(opts, 'e');
    return this.db.prepare(`SELECT e.day, SUM(e.usd) usd, COUNT(*) n FROM effective e ${where}
      AND e.ts >= ? AND e.ts < ? GROUP BY e.day ORDER BY e.day`)
      .all(...params, Math.floor(fromSec), Math.floor(toSec))
      .map((r) => ({ ...r, day: dayStr(r.day) }));
  }

  /** 没价的调用（价目表漏了模型时，这里必须有人看得见）。零 token 的不算——没什么可定价的。 */
  unpriced(fromSec, toSec) {
    return this.db.prepare(`SELECT d.name model, COUNT(*) n, SUM(c.i+c.o) tokens, SUM(c.cr+c.cw) cache_tokens
      FROM calls c JOIN dims d ON d.id = c.model
      WHERE c.priced = 0 AND c.billable = 1 AND (c.i+c.o+c.cr+c.cw) > 0 AND c.ts >= ? AND c.ts < ?
      GROUP BY c.model ORDER BY tokens DESC`).all(Math.floor(fromSec), Math.floor(toSec));
  }

  /**
   * 按**当前**价目表重算全库美元。这是「流水进 SQLite」最直接的回报：价目表补一个模型之后，
   * 历史不用重建——重算一遍就对了。旧账本时代做不到：美元在解析那一刻就写死了。
   *
   * 三件事必须说清（不然就是「看起来重算了」）：
   *  1. `calls.usd` 按当前价目重算，`priced` 跟着翻（原来没价、现在有价 → 变 1）；
   *  2. `hourly`（汇总层）里**还能在明细里找到的那些小时**跟着重算——更早的明细已经被修剪掉，
   *     那部分没有原始 token 可重算，只能保持原样；`hourlyStale` 如实报出有多少行没动；
   *  3. 没价的模型**不猜**：usd=0、priced=0，仍然只记 token（有人看得见，见 `unpriced()`）。
   *
   * @returns {{ models:number, calls:number, hourly:number, hourlyStale:number, unpriced:string[] }}
   */
  reprice({ pricing }) {
    const dims = this.db.prepare("SELECT id, name FROM dims WHERE kind = 'model'").all();
    const unpriced = [];
    let calls = 0;
    this.db.exec('BEGIN');
    try {
      for (const m of dims) {
        const p = pricing?.price?.(m.name);
        if (!p) {
          // 没价 → 清成 0 并标 priced=0（不借用别的模型的价：那是静默的偏差）
          calls += this.db.prepare('UPDATE calls SET usd = 0, priced = 0 WHERE model = ? AND (usd != 0 OR priced != 0)').run(m.id).changes;
          if (this.db.prepare('SELECT 1 FROM calls WHERE model = ? AND (i+o+cr+cw) > 0 LIMIT 1').get(m.id)) unpriced.push(m.name);
          continue;
        }
        calls += this.db.prepare(`UPDATE calls SET
            usd = (i * ? + o * ? + cr * ? + cw * ?) / 1000000.0, priced = 1
          WHERE model = ? AND (priced != 1 OR usd != (i * ? + o * ? + cr * ? + cw * ?) / 1000000.0)`)
          .run(p[0], p[1], p[2], p[3], m.id, p[0], p[1], p[2], p[3]).changes;
      }
      // 汇总层：只重算「明细还在」的那些小时。删了再插，与 prune 那条路同一个口径。
      const stale = this.db.prepare('SELECT COUNT(*) n FROM hourly WHERE hour NOT IN (SELECT DISTINCT hour FROM calls)').get().n;
      this.db.exec('DELETE FROM hourly WHERE hour IN (SELECT DISTINCT hour FROM calls)');
      const hourly = this.db.prepare(`INSERT INTO hourly
          (hour, day, machine, model, sess, ws, src, side, priced, billable, usd, i, o, cr, cw, n)
        SELECT hour, day, machine, model, sess, ws, src, side, priced, billable,
               SUM(usd), SUM(i), SUM(o), SUM(cr), SUM(cw), COUNT(*)
        FROM calls GROUP BY hour, machine, model, sess, ws, src, side, priced, billable`).run().changes;
      this.db.exec('COMMIT');
      this.invalidate?.();
      return { models: dims.length, calls, hourly, hourlyStale: stale, unpriced };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** 同一窗口里两边各记了多少——对账页那张表。 */
  reconcile(fromSec, toSec, { tolerance = 1.1 } = {}) {
    const rows = this.db.prepare(`SELECT d.name model, c.side, SUM(c.usd) usd FROM calls c
      JOIN dims d ON d.id = c.model
      WHERE c.billable = 1 AND c.ts >= ? AND c.ts < ? GROUP BY c.model, c.side`)
      .all(Math.floor(fromSec), Math.floor(toSec));
    const by = new Map();
    for (const r of rows) {
      const cur = by.get(r.model) ?? { model: r.model, t: 0, g: 0 };
      cur[r.side] = r.usd;
      by.set(r.model, cur);
    }
    return [...by.values()].map((r) => ({
      ...r, gap: r.g - r.t, ratio: r.t > 0 ? r.g / r.t : (r.g > 0 ? Infinity : 1),
      gapWorthReporting: r.g > Math.max(r.t * tolerance, 0.05),
    })).sort((a, b) => b.g - a.g);
  }

  /** 维度名 → id 的过滤器（模型名支持 LIKE，档位组是子串匹配）。 */
  #filters(opts = {}, alias = 'e') {
    const w = [];
    const p = [];
    const dimEq = (col, kind, name) => { w.push(`${alias}.${col} = (SELECT id FROM dims WHERE kind = ? AND name = ?)`); p.push(kind, String(name)); };
    if (opts.machine) dimEq('machine', 'machine', opts.machine);
    if (opts.model) dimEq('model', 'model', opts.model);
    if (opts.sid) dimEq('sess', 'session', opts.sid);
    if (opts.ws) dimEq('ws', 'ws', opts.ws);
    if (opts.group) {
      w.push(`${alias}.model IN (SELECT id FROM dims WHERE kind = 'model' AND name LIKE ?)`);
      p.push('%' + String(opts.group).toLowerCase() + '%');
    }
    if (opts.family) {
      // 家族不是存在 calls 里的列（那会为每行多背几个字节），而是由模型名推出来的：
      // 先把库里的模型名取出来归类，再按 id 过滤。模型数是个位数，这点开销可以忽略。
      const ids = this.db.prepare("SELECT id, name FROM dims WHERE kind = 'model'").all()
        .filter((r) => modelFamily(r.name).id === String(opts.family)).map((r) => r.id);
      w.push(ids.length ? `${alias}.model IN (${ids.map(() => '?').join(',')})` : '0');
      p.push(...ids);
    }
    return { where: w.length ? 'WHERE ' + w.join(' AND ') : 'WHERE 1=1', params: p };
  }

  // MARK: 保留与汇总

  /**
   * 把 `beforeDay` 之前的明细汇进 `hourly` 再删掉。**先汇总后删**是硬顺序：反了就永久丢数。
   * @param beforeDay YYYYMMDD 整数（或 'YYYY-MM-DD'）
   * @returns {{ rolled: number, deleted: number }}
   */
  prune({ beforeDay, keepDetailDays = null } = {}) {
    // 接受 'YYYY-MM-DD' 或整数 YYYYMMDD：列是整数，混用字符串会踩到 SQLite 的类型亲和
    // （'2026-09-01' 会被当数字 2026 去比，于是该删的没删、不该删的全删了）。
    const norm = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? Number(d.replace(/-/g, '')) : d);
    const day = norm(beforeDay) ?? (keepDetailDays != null ? dayInt(Date.now() / 1000 - keepDetailDays * 86400) : null);
    if (!day) throw new Error('prune 需要 beforeDay（YYYY-MM-DD 或 YYYYMMDD）或 keepDetailDays');
    // 早退：refresh() 每 15 秒调一次 prune，而绝大多数时候没有过期的明细可汇。
    // 用 day 索引取最早一天比"先分组数一遍"便宜几个数量级。
    const oldest = this.db.prepare('SELECT MIN(day) d FROM calls').get().d;
    if (oldest == null || oldest >= day) return { rolled: 0, deleted: 0 };
    const rolled = this.db.prepare(`SELECT COUNT(*) n FROM (
      SELECT 1 FROM calls WHERE day < ? GROUP BY hour, machine, model, sess, ws, src, side, priced, billable)`).get(day).n;
    this.db.exec('BEGIN');
    try {
      // 必须用 prepare().run(day) 而不是 exec()：**exec 不绑定参数**，SQL 里的 `?` 会当 NULL，
      // 于是 `day < NULL` 恒为假——汇总静默插 0 行，接着 DELETE 把明细删光，数据就永久没了。
      // 2026-09-23 契约测试逮到的正是这个（先汇总后删的顺序对，但汇总那步什么都没干）。
      this.db.prepare(`INSERT INTO hourly (hour,day,machine,model,sess,ws,src,side,priced,billable,usd,i,o,cr,cw,n)
        SELECT hour,day,machine,model,sess,ws,src,side,priced,billable,SUM(usd),SUM(i),SUM(o),SUM(cr),SUM(cw),COUNT(*)
        FROM calls WHERE day < ?
        GROUP BY hour,machine,model,sess,ws,src,side,priced,billable
        ON CONFLICT(hour,machine,model,sess,ws,src,side,priced,billable) DO UPDATE SET
          usd=excluded.usd, i=excluded.i, o=excluded.o, cr=excluded.cr, cw=excluded.cw, n=excluded.n`).run(day);
      const del = this.db.prepare('DELETE FROM calls WHERE day < ?').run(day);
      this.db.exec('COMMIT');
      return { rolled, deleted: del.changes };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /**
   * 明细 + 汇总的合计（报表用：明细窗口内走 calls，窗口外走 hourly）。
   *
   * **历史区间也按同一套口径算**，不能把汇总直接加起来——那是并集（旧账本的做法），
   * 而且会把 `billable = 0` 的调用也算进账号花费（2026-09-23 实咬：本该 $35 的汇总报成 $90）。
   * 汇总表按小时存，所以这里的 max 与 `effective` 视图**逐字一致**，历史与当下不会两个数。
   */
  totalWithDaily(fromSec, toSec, opts = {}) {
    const live = this.spend(fromSec, toSec, opts);
    const fromDay = dayInt(Math.floor(fromSec)), toDay = dayInt(Math.floor(toSec));
    const w = ['day >= ?', 'day < ?', 'billable = 1'];
    const p = [fromDay, toDay];
    if (opts.machine) { w.push('machine = (SELECT id FROM dims WHERE kind = ? AND name = ?)'); p.push('machine', String(opts.machine)); }
    if (opts.model) { w.push('model = (SELECT id FROM dims WHERE kind = ? AND name = ?)'); p.push('model', String(opts.model)); }
    if (opts.group) { w.push("model IN (SELECT id FROM dims WHERE kind = 'model' AND name LIKE ?)"); p.push('%' + String(opts.group).toLowerCase() + '%'); }
    const where = w.join(' AND ');
    const basis = this.basis;
    let sql;
    if (basis === 'union') {
      sql = `SELECT COALESCE(SUM(usd),0) usd, COALESCE(SUM(n),0) n FROM hourly WHERE ${where}`;
    } else if (basis === 't' || basis === 'g') {
      sql = `SELECT COALESCE(SUM(usd),0) usd, COALESCE(SUM(n),0) n FROM hourly WHERE ${where} AND side = '${basis}'`;
    } else {
      // max：与 effective 视图同一个分区、同一个排序（合计降序、同分按 side）
      sql = `SELECT COALESCE(SUM(usd),0) usd, COALESCE(SUM(n),0) n FROM (
        SELECT hour, machine, model, side, SUM(usd) usd, SUM(n) n,
               ROW_NUMBER() OVER (PARTITION BY machine, model, hour ORDER BY SUM(usd) DESC, side) rn
        FROM hourly WHERE ${where} GROUP BY machine, model, hour, side
      ) WHERE rn = 1`;
    }
    const rolled = this.db.prepare(sql).get(...p);
    return { usd: live.usd + rolled.usd, calls: live.calls + rolled.n, liveUSD: live.usd, rolledUSD: rolled.usd };
  }

  /** 库的实际占用（页数 × 页大小），排查磁盘时用。 */
  diskBytes() {
    const ps = this.db.prepare('PRAGMA page_size').get().page_size;
    const pc = this.db.prepare('PRAGMA page_count').get().page_count;
    return ps * pc;
  }

  // MARK: 打包（迁 VPS）

  /**
   * 出一份一致的单文件快照。WAL 模式下直接拷 .db 会漏掉 -wal 里的新数据，
   * `VACUUM INTO` 是 SQLite 官方的正确做法（顺带把碎片压掉，实测 21.8MB → 5.4MB）。
   */
  pack(target) {
    if (existsSync(target)) rmSync(target);
    mkdirSync(dirname(target), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(target);
    return target;
  }

  /** 校验一份快照能不能用（schema 版本 + integrity + 行数 + 时间跨度）。 */
  static inspect(file) {
    const db = new DatabaseSync(file);
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version ?? 0;
      const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
      const calls = db.prepare('SELECT COUNT(*) n FROM calls').get().n;
      const rolled = db.prepare('SELECT COUNT(*) n FROM hourly').get().n;
      const span = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM calls').get();
      const ps = db.prepare('PRAGMA page_size').get().page_size;
      const pc = db.prepare('PRAGMA page_count').get().page_count;
      return { file, version, integrity, calls, rolled, from: span.a, to: span.b, bytes: ps * pc };
    } finally { db.close(); }
  }

  close() { try { this.db.close(); } catch { /* 已关 */ } }
}

/** 家族名（`byModel` 的展示列）：模型名 → 家族 id → 展示名。 */
function familyOf(modelName) {
  return familyLabel(modelFamily(modelName).id);
}
