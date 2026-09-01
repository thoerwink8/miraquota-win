/**
 * 点数增量归因：把官方点数窗口的 used 增量按同期各模型家族的账本美元占比分摊，
 * 得到「每家族实测消耗了多少点」——不经美元汇率反推，直接用 /v1/limits 的权威增量。
 *
 * 口径与防线：
 *  - 基准窗取非模型档位、周期最短的那个（5h）：分辨率最高，且与 7d 计的是同一池；
 *  - 跨重置的采样只收缩基线不产增量（重置前的尾巴宁漏勿错）；
 *  - relay 的 token 回填有延迟，增量先进 pending 队列、满 SETTLE 秒后才用账本分摊，
 *    避免「点数已跳、美元还没回填」时错归到无主；
 *  - 同期账本无任何家族支出时记为无主（他机用量 / 回填过期未到），单列不硬塞。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { windowDuration } from './windows.mjs';

const STATE_FILE = join(homedir(), '.miraquota', 'points-attrib.json');
const RETENTION_MIN = 8 * 1440;   // 与 ledger 同窗：8 天分钟数
const SETTLE_SEC = 300;           // 等 relay 回填的静置时长
const UNATTR = '?';               // 无主家族键

export class PointsAttributor {
  constructor(stateFile = STATE_FILE) {
    this.stateFile = stateFile;
    this.buckets = {};   // "家族|分钟" → 点数（家族为 ? 时是无主）
    this.last = null;    // { label, resetAt, used, at } 基准窗上次采样
    this.pending = [];   // [{ from, to, points }] 待静置的增量
    this.sinceSec = null; // 归因起始时刻（覆盖率判断用）
    this.settleSec = SETTLE_SEC;
    this.#index = {};
    this.#load();
  }

  /**
   * 多机账本同步启用时放宽静置：外机支出要等它下一轮发布分片才可见，
   * 静置短于同步间隔会把他机点数错归无主。取 max(默认, 2×同步间隔)。
   */
  relaxSettle(intervalSec) {
    this.settleSec = Math.max(SETTLE_SEC, 2 * (Number(intervalSec) || 0));
  }

  #index;

  #load() {
    try {
      const p = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      this.buckets = p.buckets ?? {};
      this.last = p.last ?? null;
      this.pending = Array.isArray(p.pending) ? p.pending : [];
      this.sinceSec = p.sinceSec ?? null;
    } catch { /* 首次运行 */ }
  }

  #save() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({
        buckets: this.buckets, last: this.last, pending: this.pending, sinceSec: this.sinceSec,
      }));
    } catch { /* 落盘失败不阻断 */ }
  }

  /** 基准窗：非模型档位里周期最短的（modelScoped 窗只覆盖单家族，不能当总池基准）。 */
  static baseWindow(windows) {
    const base = (windows ?? []).filter((w) => !w.modelScoped && w.resetAt != null);
    if (!base.length) return null;
    return base.reduce((a, b) =>
      ((windowDuration(a.label) ?? Infinity) <= (windowDuration(b.label) ?? Infinity) ? a : b));
  }

  /** 每次实测 /v1/limits 后喂进来。产生的增量先挂 pending，等静置后由 settle 分摊。 */
  record(windows, nowSec) {
    const w = PointsAttributor.baseWindow(windows);
    if (!w) return;
    const prev = this.last;
    this.last = { label: w.label, resetAt: w.resetAt, used: w.used, at: nowSec };
    if (this.sinceSec == null) this.sinceSec = nowSec;
    if (!prev || prev.label !== w.label) { this.#save(); return; }
    // 窗口重置（resetAt 变了）：本次 used 从 0 重新累计，重置前后的差值无法对齐，只重挂基线。
    if (prev.resetAt !== w.resetAt) { this.#save(); return; }
    const delta = w.used - prev.used;
    if (delta > 0) this.pending.push({ from: prev.at, to: nowSec, points: delta });
    this.#save();
  }

  /** 静置到期的增量按账本家族美元占比分摊入桶。每轮 refresh 后调用。 */
  settle(ledger, nowSec) {
    if (!this.pending.length) return;
    const due = [];
    this.pending = this.pending.filter((p) => (nowSec - p.to >= this.settleSec ? (due.push(p), false) : true));
    if (!due.length) return;
    const ids = ledger.familyIds();
    for (const p of due) {
      const weights = ids.map((id) => [id, ledger.familySpent(p.from, p.to, id, { includeOpenMinute: true })])
        .filter(([, usd]) => usd > 0);
      const total = weights.reduce((a, [, usd]) => a + usd, 0);
      const minute = Math.floor(p.to / 60);
      if (total > 0) {
        for (const [id, usd] of weights) this.#add(id, minute, p.points * (usd / total));
      } else {
        this.#add(UNATTR, minute, p.points);
      }
    }
    this.#prune(nowSec);
    this.#save();
  }

  #add(id, minute, points) {
    const key = id + '|' + minute;
    this.buckets[key] = (this.buckets[key] ?? 0) + points;
    this.#index[id] = null;
  }

  #prune(nowSec) {
    const cut = Math.floor(nowSec / 60) - RETENTION_MIN;
    for (const k of Object.keys(this.buckets)) {
      if (Number(k.slice(k.indexOf('|') + 1)) < cut) { delete this.buckets[k]; this.#index = {}; }
    }
  }

  /** [fromSec, toSec) 内归到该家族的点数。id 传 '?' 查无主。 */
  familyPoints(fromSec, toSec, id) {
    const table = this.#table(id);
    if (!table.minutes.length) return 0;
    const lo = lowerBound(table.minutes, Math.floor(fromSec / 60));
    const hi = lowerBound(table.minutes, Math.floor(toSec / 60) + 1);
    return table.prefix[hi] - table.prefix[lo];
  }

  unattributedPoints(fromSec, toSec) { return this.familyPoints(fromSec, toSec, UNATTR); }

  /** 归因自某时刻起才有数据；查询区间早于它则统计不完整。 */
  covers(fromSec) { return this.sinceSec != null && this.sinceSec <= fromSec; }

  #table(id) {
    if (!this.#index[id]) {
      const head = id + '|';
      const entries = Object.entries(this.buckets)
        .filter(([k]) => k.startsWith(head))
        .map(([k, v]) => [Number(k.slice(head.length)), v])
        .sort((a, b) => a[0] - b[0]);
      const prefix = new Array(entries.length + 1).fill(0);
      for (let i = 0; i < entries.length; i++) prefix[i + 1] = prefix[i] + entries[i][1];
      this.#index[id] = { minutes: entries.map((e) => e[0]), prefix };
    }
    return this.#index[id];
  }
}

function lowerBound(a, target) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < target) lo = mid + 1; else hi = mid; }
  return lo;
}
