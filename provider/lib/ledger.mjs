/**
 * 成本账本：增量扫描 Claude Code 的 transcript 与 Mirasim 的网关账本，
 * 把每次调用的 token 折算成 API 等价美元，按分钟聚合。移植自 Swift 版 CostLedger.swift。
 *
 * 两个来源都不完备，故取并集，用 Anthropic 的 request id 跨源去重
 * （transcript 的 `requestId` 即网关账本的 `providerCallId`）：
 *  - transcript：token 完整、可回溯全部历史，但只记录写回会话的助手消息；
 *  - 网关账本：记下每一次经中继的请求，但 token 由 relay 事后回填、只重扫尾部窗口。
 *
 * 与 Swift 版的差异（为道日损，还原口径而不照抄性能工程）：
 *  - transcript 用「文件大小 + 字节偏移」增量读（追加型，游标有效）；
 *  - 网关账本每轮重扫尾部窗口（回填原地改写，游标会漏），按 id 记账、回填到达补差额；
 *  - 分钟桶查询用惰性前缀和，标定的成百上千次 spent 调用不退化成平方级。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isRelayCharged, modelFamily } from './model-families.mjs';

const HOME = homedir();
const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects');
const INSIGHTS = join(HOME, '.mirasim', 'insights');
const STATE_DIR = join(HOME, '.miraquota');
const STATE_FILE = join(STATE_DIR, 'ledger.json');

const RETENTION = 8 * 86400;          // 覆盖 7d 窗口并留余量
const GATEWAY_RESCAN = 1 << 20;       // 网关账本尾部重扫窗口
const STATE_SCHEMA = 2;               // v2 扩展 GPT 定价后需重扫 transcript 补旧漏账
const SHARD_SCHEMA = 1;               // 多机同步分片格式（见 ledger-sync.mjs / docs/MULTI-MACHINE.md）；unpriced 字段可选，旧分片没有

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** 递归收集 .jsonl，标出 nested（子代理会话在 <项目> 更深一层）。 */
function walkTranscripts(dir, depth, out) {
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) walkTranscripts(p, depth + 1, out);
    else if (it.name.endsWith('.jsonl')) out.push({ path: p, nested: depth > 1 });
  }
}

export class CostLedger {
  /** @param stateFile 状态文件路径（测试注入用，默认 ~/.miraquota/ledger.json） */
  constructor(pricing, stateFile = STATE_FILE) {
    this.pricing = pricing;
    this.stateFile = stateFile;
    this.cursors = {};        // transcript 文件 → { size, offset }
    this.buckets = {};        // unix 分钟 → 美元
    this.scoped = {};         // "组|分钟" → 美元
    this.family = {};         // "家族|分钟" → 官方云端模型家族美元
    this.familyBooked = {};   // 账目键 → { id, usd }（回填变大时补差额）
    this.familyLatest = {};   // 家族 → 最近一次成功云端请求秒时间戳
    this.seen = {};           // 账目键 → 入桶分钟
    this.booked = {};         // 账目键 → 已计金额（见更大值补差额）
    this.scopedSince = {};    // 组 → 起始分钟
    // 经 relay 扣了点、但价目表没价的调用："模型|分钟" → token 数。没价就没美元，只能记 token；
    // 记下来的意义是让它在面板上有名有姓，而不是消失进「未同步机器」那条残差里。
    this.unpriced = {};
    this.unpricedBooked = {};  // 账目键 → 已计 token（回填变大补差额）
    this.scopedGroups = [];
    this.gatewayScanned = {}; // 网关文件 → 上次 mtimeMs
    this.fullGatewayScanDone = false;
    this.transcriptRecords = 0;
    this.ledgerRecords = 0;
    this.unpricedRecords = 0;
    this.countedLedger = new Set();
    this.foreignShards = [];  // 多机同步吸收的外机分片（不落盘，重启后由下一轮同步重建）
    this.#index = null;
    this.#scopedIndex = {};
    this.#familyIndex = {};
    this.#mergedIndex = null;
    this.#mergedScopedIndex = {};
    this.#mergedFamilyIndex = {};
    this.#load();
  }

  #index; #scopedIndex; #familyIndex;
  #mergedIndex; #mergedScopedIndex; #mergedFamilyIndex;

  #load() {
    try {
      const p = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      this.cursors = p.cursors ?? {};
      this.buckets = p.buckets ?? {};
      this.scoped = p.scoped ?? {};
      this.family = p.family ?? {};
      this.familyBooked = p.familyBooked ?? {};
      this.familyLatest = p.familyLatest ?? {};
      this.seen = p.seen ?? {};
      this.booked = p.booked ?? {};
      this.scopedSince = p.scopedSince ?? {};
      this.unpriced = p.unpriced ?? {};
      this.unpricedBooked = p.unpricedBooked ?? {};
      if ((p.schemaVersion ?? 1) < STATE_SCHEMA) {
        // 已计账目仍由 seen/booked 去重；只归零读取游标，让过去因未知模型价被跳过的记录重新定价。
        for (const path of Object.keys(this.cursors)) this.cursors[path] = { size: 0, offset: 0 };
      }
    } catch { /* 首次运行 */ }
  }

  #save() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({
        schemaVersion: STATE_SCHEMA,
        cursors: this.cursors, buckets: this.buckets, scoped: this.scoped, family: this.family,
        familyBooked: this.familyBooked, familyLatest: this.familyLatest,
        seen: this.seen, booked: this.booked, scopedSince: this.scopedSince,
        unpriced: this.unpriced, unpricedBooked: this.unpricedBooked,
      }));
    } catch { /* 落盘失败不阻断 */ }
  }

  /** 声明需要单独分桶的模型档位组（`7d_fable` → `fable`）。 */
  adoptScopedGroups(groups) {
    const norm = [...new Set(groups.map((g) => g.toLowerCase()).filter(Boolean))].sort();
    if (norm.join(',') === this.scopedGroups.join(',')) return;
    this.scopedGroups = norm;
    const nowMin = Math.floor(Date.now() / 60000);
    let dirty = false;
    for (const g of norm) if (this.scopedSince[g] == null) { this.scopedSince[g] = nowMin; dirty = true; }
    if (dirty) this.#save();
  }

  /** 该组分桶是否已覆盖到给定时刻。未覆盖时其支出偏低，展示需据此让位。 */
  scopedComplete(group, fromSec) {
    const since = this.scopedSince[group.toLowerCase()];
    return since != null && since <= Math.floor(fromSec / 60);
  }

  #add(minute, usd, model = '') {
    const key = String(minute);
    this.buckets[key] = (this.buckets[key] ?? 0) + usd;
    this.#index = null;
    this.#mergedIndex = null;
    if (!this.scopedGroups.length || !model) return;
    const lower = model.toLowerCase();
    for (const g of this.scopedGroups) if (lower.includes(g)) {
      const k = g + '|' + key;
      this.scoped[k] = (this.scoped[k] ?? 0) + usd;
      this.#scopedIndex[g] = null;
      this.#mergedScopedIndex[g] = null;
    }
  }

  #addFamily(minute, usd, familyId) {
    const key = familyId + '|' + minute;
    this.family[key] = (this.family[key] ?? 0) + usd;
    this.#familyIndex[familyId] = null;
    this.#mergedFamilyIndex[familyId] = null;
  }

  refresh(now = Date.now()) {
    const cutoff = Math.floor((now - RETENTION * 1000) / 1000);
    let changed = false;
    changed = this.#scanTranscripts(cutoff) || changed;
    changed = this.#scanGateway(cutoff) || changed;
    this.#prune(cutoff);
    if (changed) this.#save();
    return changed;
  }

  #scanTranscripts(cutoff) {
    const files = [];
    walkTranscripts(CLAUDE_PROJECTS, 0, files);
    let changed = false;
    for (const { path } of files) {
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs / 1000 < cutoff) continue;      // 整个文件早于保留窗口
      const size = st.size;
      let cur = this.cursors[path] ?? { size: 0, offset: 0 };
      if (size < cur.size) cur = { size: 0, offset: 0 };  // 被截断，游标归零
      if (size <= cur.offset) { this.cursors[path] = { size, offset: cur.offset }; continue; }
      const text = readRange(path, cur.offset, size);
      if (!text) continue;
      let consumed = 0, nl;
      let start = 0;
      while ((nl = text.indexOf('\n', start)) >= 0) {
        const line = text.slice(start, nl);
        if (line.includes('"usage"')) this.#parseTranscript(line, cutoff);
        start = nl + 1; consumed = start;
      }
      this.cursors[path] = { size, offset: cur.offset + Buffer.byteLength(text.slice(0, consumed), 'utf8') };
      if (consumed > 0) changed = true;
    }
    return changed;
  }

  #parseTranscript(line, cutoff) {
    let root;
    try { root = JSON.parse(line); } catch { return; }
    const ts = root.timestamp;
    const epoch = ts ? Math.floor(Date.parse(ts) / 1000) : NaN;
    const usage = root.message?.usage;
    if (!Number.isFinite(epoch) || epoch < cutoff || !usage) return;
    const minute = Math.floor(epoch / 60);
    const rid = root.requestId ?? root.message?.id;
    // 已计过且知道金额：一次响应写成多行（思考/工具调用/正文各一行），取最大值补差额。
    if (rid && this.booked[rid] == null && this.seen[rid] != null) return;

    const model = root.message?.model ?? '';
    const usd = this.pricing.cost(model, num(usage.input_tokens), num(usage.output_tokens),
      num(usage.cache_read_input_tokens), num(usage.cache_creation_input_tokens));
    if (usd == null) { this.unpricedRecords++; return; }
    if (!rid) { this.#add(minute, usd, model); this.transcriptRecords++; return; }
    const prior = this.booked[rid];
    if (prior != null) {
      if (usd <= prior) return;
      this.#add(this.seen[rid] ?? minute, usd - prior, model);
      this.booked[rid] = usd;
      return;
    }
    this.seen[rid] = minute;
    this.booked[rid] = usd;
    this.#add(minute, usd, model);
    this.transcriptRecords++;
  }

  #scanGateway(cutoff) {
    let files;
    try { files = readdirSync(INSIGHTS); } catch { return false; }
    // 每次启动先整读一遍补齐停机期记录，之后按尾部窗口重扫。重复入账由账目键拦下。
    const window = this.fullGatewayScanDone ? GATEWAY_RESCAN : Infinity;
    this.fullGatewayScanDone = true;
    let changed = false;
    for (const name of files) {
      if (!name.startsWith('usage-') || !name.endsWith('.ndjson')) continue;
      const path = join(INSIGHTS, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (this.gatewayScanned[path] === st.mtimeMs) continue;  // 未变（回填不改长度，判 mtime）
      this.gatewayScanned[path] = st.mtimeMs;
      const offset = window >= st.size ? 0 : st.size - window;
      const text = readRange(path, offset, st.size);
      if (!text) continue;
      const lines = text.split('\n');
      const from = offset > 0 ? 1 : 0;   // 起点可能落在半行，跳过第一行
      for (let i = from; i < lines.length; i++) if (this.#parseGateway(lines[i], cutoff)) changed = true;
    }
    return changed;
  }

  /** 喂一行网关账本（测试与重放用；生产路径走 refresh → #scanGateway）。 */
  ingestGatewayLine(line, cutoff = 0) { return this.#parseGateway(line, cutoff); }

  #parseGateway(line, cutoff) {
    let root;
    try { root = JSON.parse(line); } catch { return false; }
    const epoch = root.ts ? Math.floor(Date.parse(root.ts) / 1000) : NaN;
    if (!Number.isFinite(epoch) || epoch < cutoff) return false;
    const id = root.id;
    if (!id) return false;

    const providerCallId = root.providerCallId;
    const key = this.seen[id] != null ? id : (providerCallId ?? id);
    const prior = this.booked[key];
    const priorFamilyBooking = this.familyBooked[key];
    if (prior == null) {
      const agent = root.agent ?? '';
      // 缺 providerCallId 的行无法与 transcript 对齐；claude/codex 另有 transcript 覆盖，宁漏勿重。
      if (providerCallId == null && (agent === 'claude' || agent === 'codex')) return false;
    }
    const model = root.model ?? '';
    const usd = model ? this.pricing.cost(model, num(root.input), num(root.output),
      num(root.cacheRead), num(root.cacheWrite)) : null;
    const billable = isRelayCharged(root);
    let familyChanged = false;
    if (billable) {
      const family = root.modelSource === 'dispatch' ? { id: 'dispatch' } : modelFamily(model);
      const priorLatest = this.familyLatest[family.id] ?? 0;
      this.familyLatest[family.id] = Math.max(priorLatest, epoch);
      if (this.familyLatest[family.id] !== priorLatest) familyChanged = true;
      if (usd != null && usd > 0) {
        const booked = this.familyBooked[key];
        const priorFamilyUSD = typeof booked === 'object' ? Number(booked.usd) || 0 : 0;
        if (usd > priorFamilyUSD) {
          this.#addFamily(Math.floor(epoch / 60), usd - priorFamilyUSD, family.id);
          this.familyBooked[key] = { id: family.id, usd };
          familyChanged = true;
        }
      }
    }
    // 总账本接纳 Anthropic 记录，以及经 Mirasim 官方 relay 的其他可定价模型（如 GPT）。
    // 直连/dispatch 请求不因模型缓存里有价格而混入官方计费家族。
    if (root.provider !== 'anthropic' && !billable) return familyChanged;
    // cost 对零 token 的已知模型返回 0——token 未回填的行此刻不入账，等回填后重读。
    if (usd == null) {
      // 价目表没这个模型：点已经扣了，美元算不出，把 token 记下来（回填变大补差额）
      const tok = num(root.input) + num(root.output);
      if (billable && tok > 0) {
        const priorTok = this.unpricedBooked[key] ?? 0;
        if (tok > priorTok) {
          const k = model + '|' + Math.floor(epoch / 60);
          this.unpriced[k] = (this.unpriced[k] ?? 0) + (tok - priorTok);
          this.unpricedBooked[key] = tok;
          familyChanged = true;
        }
      }
      this.unpricedRecords++;
      return familyChanged;
    }
    if (usd <= 0) return familyChanged;
    if (prior == null && this.seen[key] != null) {
      // v1 已见过但未定价的 GPT 请求：v2 从 ai-router 获得价格后允许一次性补账。
      // 其他旧账目继续宁漏勿重；补账后 booked 会阻止后续重复。
      const legacyFamily = typeof priorFamilyBooking === 'object' ? priorFamilyBooking.id : priorFamilyBooking;
      if (legacyFamily !== 'gpt') return familyChanged;
    }
    if (prior != null) {
      if (usd <= prior) return familyChanged;
      this.#add(this.seen[key] ?? Math.floor(epoch / 60), usd - prior, model);
      this.booked[key] = usd;
    } else {
      const minute = Math.floor(epoch / 60);
      this.seen[key] = minute;
      this.booked[key] = usd;
      this.#add(minute, usd, model);
      if (!this.countedLedger.has(id)) { this.countedLedger.add(id); this.ledgerRecords++; }
    }
    return true;
  }

  #prune(cutoff) {
    const minCut = Math.floor(cutoff / 60);
    const before = Object.keys(this.buckets).length;
    for (const k of Object.keys(this.buckets)) if (Number(k) < minCut) delete this.buckets[k];
    for (const k of Object.keys(this.scoped)) {
      const m = Number(k.split('|').pop());
      if (m < minCut) delete this.scoped[k];
    }
    for (const k of Object.keys(this.family)) {
      const m = Number(k.split('|').pop());
      if (m < minCut) delete this.family[k];
    }
    for (const id of Object.keys(this.familyLatest)) if (this.familyLatest[id] < cutoff) delete this.familyLatest[id];
    for (const k of Object.keys(this.unpriced)) {
      const m = Number(k.split('|').pop());
      if (m < minCut) { delete this.unpriced[k]; }
    }
    for (const k of Object.keys(this.seen)) if (this.seen[k] < minCut) {
      delete this.seen[k]; delete this.booked[k]; delete this.familyBooked[k]; delete this.unpricedBooked[k];
    }
    for (const k of Object.keys(this.cursors)) {
      try { statSync(k); } catch { delete this.cursors[k]; }
    }
    if (Object.keys(this.buckets).length !== before) { this.#index = null; this.#mergedIndex = null; }
    if (Object.keys(this.scoped).length) { this.#scopedIndex = {}; this.#mergedScopedIndex = {}; }
    if (Object.keys(this.family).length) { this.#familyIndex = {}; this.#mergedFamilyIndex = {}; }
  }

  // MARK: 多机分片（详见 docs/MULTI-MACHINE.md）

  /** 本机账本聚合态 → 同步分片。只含本机桶——外机分片单独存放，不回流串账。 */
  exportShard(machineId, nowSec = Date.now() / 1000, identity = {}) {
    return {
      schemaVersion: SHARD_SCHEMA,
      machineId,
      // 收件口模式的身份：account 是自报名字，installId 是首次运行生成的随机 id（同名主机不撞）
      ...(identity.account ? { account: identity.account } : {}),
      ...(identity.installId ? { installId: identity.installId } : {}),
      generatedAt: nowSec,
      coverage: { fromSec: nowSec - RETENTION, toSec: nowSec },
      buckets: this.buckets, scoped: this.scoped, family: this.family,
      unpriced: this.unpriced,
    };
  }

  /**
   * 吸收外机分片：此后 spent/activeMinutes/familySpent 默认返回本机 + 全部外机之和，
   * 传 { localOnly: true } 仍可查纯本机口径。无分片时合并口径 = 本机口径，行为零变化。
   */
  adoptForeignShards(shards) {
    this.foreignShards = (Array.isArray(shards) ? shards : [])
      .map((s) => (s?.schemaVersion === 2 ? this.#materialize(s) : s))
      .filter((s) => s && s.schemaVersion === SHARD_SCHEMA && s.machineId);
    this.#mergedIndex = null;
    this.#mergedScopedIndex = {};
    this.#mergedFamilyIndex = {};
  }

  /**
   * 窗口内没价的调用，按模型汇总 token（本机 + 外机分片）。有价的不在这里——它们在 spent 里。
   * @returns [{ model, tokens }] 按 token 降序
   */
  unpricedUsage(fromSec, toSec) {
    const lo = Math.floor(fromSec / 60), hi = Math.floor(toSec / 60);
    const sum = new Map();
    const fold = (obj) => {
      for (const [k, v] of Object.entries(obj ?? {})) {
        const cut = k.lastIndexOf('|');
        const m = Number(k.slice(cut + 1));
        if (!Number.isFinite(m) || m < lo || m > hi) continue;
        const model = k.slice(0, cut);
        sum.set(model, (sum.get(model) ?? 0) + (Number(v) || 0));
      }
    };
    fold(this.unpriced);
    for (const s of this.foreignShards) fold(s.unpriced);
    return [...sum.entries()].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens);
  }

  /**
   * 按机器拆开的窗口支出——多机页要回答「谁花的」。
   * 官方点数只有账号级一个总数，拆不出人；能拆的只有各机自己的账本（本机 + 同步来的分片）。
   * 这里不走合并索引：合并的意义就是抹掉机器边界，正好和这个问题相反。
   * @returns [{ machineId, self, usd, groupUSD }]，本机 machineId 由调用方给。
   */
  perMachineSpent(fromSec, toSec, { group = null, selfId = null, self = null } = {}) {
    const lo = Math.floor(fromSec / 60), hi = Math.floor(toSec / 60);
    const head = group ? group.toLowerCase() + '|' : null;
    const sum = (obj, pre) => {
      let t = 0;
      for (const [k, v] of Object.entries(obj ?? {})) {
        if (pre != null && !k.startsWith(pre)) continue;
        const m = Number(pre != null ? k.slice(pre.length) : k);
        if (Number.isFinite(m) && m >= lo && m <= hi) t += Number(v) || 0;
      }
      return t;
    };
    const row = (src, machineId, isSelf, identity) => ({
      machineId, self: isSelf,
      account: identity?.account ?? null,
      installId: identity?.installId ?? null,
      usd: sum(src.buckets, null),
      groupUSD: head ? sum(src.scoped, head) : 0,
    });
    const me = self ?? { machineId: selfId };
    return [row(this, me.machineId ?? selfId, true, me),
      ...this.foreignShards.map((s) => row(s, s.machineId, false, s))];
  }

  #materialized = new Map();
  /**
   * 轻客户端只传原始行（时间、模型、token），定价在这里做——它机器上不带价目表，
   * 价目变了也不用管它。落成与本机同构的 v1 分片，后面所有查询不用知道它的出身。
   * 与本机 #parseGateway 同一套规则：dispatch 归「调度」家族，没价的记 unpriced。
   */
  #materialize(raw) {
    const key = `${raw.installId ?? raw.machineId}|${raw.generatedAt}`;
    const hit = this.#materialized.get(key);
    if (hit) return hit;
    const out = {
      schemaVersion: SHARD_SCHEMA, machineId: raw.machineId, generatedAt: raw.generatedAt,
      coverage: raw.coverage, account: raw.account, installId: raw.installId, fromRows: true,
      buckets: {}, scoped: {}, family: {}, unpriced: {},
    };
    const bump = (obj, k, v) => { obj[k] = (obj[k] ?? 0) + v; };
    for (const r of Array.isArray(raw.rows) ? raw.rows : []) {
      if (typeof r?.t !== 'number' || typeof r?.m !== 'string') continue;
      const minute = Math.floor(r.t / 60);
      const usd = this.pricing.cost(r.m, num(r.i), num(r.o), num(r.cr), num(r.cw));
      if (usd == null) { const tok = num(r.i) + num(r.o); if (tok > 0) bump(out.unpriced, `${r.m}|${minute}`, tok); continue; }
      if (usd <= 0) continue;
      bump(out.buckets, String(minute), usd);
      const lower = r.m.toLowerCase();
      for (const g of this.scopedGroups) if (lower.includes(g)) bump(out.scoped, `${g}|${minute}`, usd);
      const fam = r.src === 'dispatch' ? 'dispatch' : modelFamily(r.m).id;
      bump(out.family, `${fam}|${minute}`, usd);
    }
    this.#materialized.clear();       // 只留最新一代，避免旧分片越攒越多
    this.#materialized.set(key, out);
    return out;
  }

  /**
   * 在场外机分片的覆盖区间（标定覆盖门用）。分片过老（generatedAt 早于保留窗）
   * 视为该机器已离场，不再参与「全覆盖」判定——它的账本早就不新鲜了。
   */
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

  // MARK: 查询

  /** 半开区间 [fromSec, toSec) 内的等价支出（秒为单位的时间戳）。 */
  spent(fromSec, toSec, { includeOpenMinute = false, group = null, localOnly = false } = {}) {
    const table = this.#table(group, localOnly);
    if (!table || !table.minutes.length) return 0;
    const lo = lowerBound(table.minutes, Math.floor(fromSec / 60));
    const hi = lowerBound(table.minutes, Math.floor(toSec / 60) + (includeOpenMinute ? 1 : 0));
    return table.prefix[hi] - table.prefix[lo];
  }

  /** 半开区间内有支出的分钟数（活跃分钟）：分钟桶只在有消费时才存在，计数即活跃。 */
  activeMinutes(fromSec, toSec, { group = null, localOnly = false } = {}) {
    const table = this.#table(group, localOnly);
    if (!table || !table.minutes.length) return 0;
    const lo = lowerBound(table.minutes, Math.floor(fromSec / 60));
    const hi = lowerBound(table.minutes, Math.floor(toSec / 60) + 1);
    return Math.max(0, hi - lo);
  }

  /** 出现过官方云端消费的家族 id 集合（含只在分钟桶里留痕的历史家族与外机分片家族）。 */
  familyIds() {
    const ids = new Set(Object.keys(this.familyLatest));
    for (const k of Object.keys(this.family)) ids.add(k.slice(0, k.indexOf('|')));
    for (const s of this.foreignShards) {
      for (const k of Object.keys(s.family ?? {})) ids.add(k.slice(0, k.indexOf('|')));
    }
    ids.delete('');
    return [...ids];
  }

  familySpent(fromSec, toSec, familyId, { includeOpenMinute = false, localOnly = false } = {}) {
    const table = this.#familyTable(familyId, localOnly);
    if (!table || !table.minutes.length) return 0;
    const lo = lowerBound(table.minutes, Math.floor(fromSec / 60));
    const hi = lowerBound(table.minutes, Math.floor(toSec / 60) + (includeOpenMinute ? 1 : 0));
    return table.prefix[hi] - table.prefix[lo];
  }

  #table(group, localOnly = false) {
    const merged = !localOnly && this.foreignShards.length > 0;
    if (group) {
      const g = group.toLowerCase();
      const idx = merged ? this.#mergedScopedIndex : this.#scopedIndex;
      if (!idx[g]) idx[g] = prefixSums(this.#entries('scoped', g + '|', merged));
      return idx[g];
    }
    if (merged) {
      if (!this.#mergedIndex) this.#mergedIndex = prefixSums(this.#entries('buckets', null, true));
      return this.#mergedIndex;
    }
    if (!this.#index) this.#index = prefixSums(this.#entries('buckets', null, false));
    return this.#index;
  }

  #familyTable(familyId, localOnly = false) {
    const id = String(familyId || '').toLowerCase();
    const merged = !localOnly && this.foreignShards.length > 0;
    const idx = merged ? this.#mergedFamilyIndex : this.#familyIndex;
    if (!idx[id]) idx[id] = prefixSums(this.#entries('family', id + '|', merged));
    return idx[id];
  }

  /**
   * 某字段（buckets/scoped/family）的 [分钟, 美元] 条目表。head 给定时只取该前缀的键并
   * 剥掉前缀；merged 为真时把全部外机分片的同名字段逐分钟求和进来。
   */
  #entries(field, head, merged) {
    const sum = new Map();
    const fold = (obj) => {
      for (const [k, v] of Object.entries(obj ?? {})) {
        if (head != null && !k.startsWith(head)) continue;
        const minute = Number(head != null ? k.slice(head.length) : k);
        if (!Number.isFinite(minute)) continue;
        sum.set(minute, (sum.get(minute) ?? 0) + (Number(v) || 0));
      }
    };
    fold(this[field]);
    if (merged) for (const s of this.foreignShards) fold(s[field]);
    return [...sum.entries()];
  }

  get totalRecords() { return this.transcriptRecords + this.ledgerRecords; }
  get bucketCount() { return Object.keys(this.buckets).length; }
}

function prefixSums(entries) {
  const sorted = entries.sort((a, b) => a[0] - b[0]);
  const prefix = new Array(sorted.length + 1).fill(0);
  for (let i = 0; i < sorted.length; i++) prefix[i + 1] = prefix[i] + sorted[i][1];
  return { minutes: sorted.map((e) => e[0]), prefix };
}

function lowerBound(a, target) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < target) lo = mid + 1; else hi = mid; }
  return lo;
}

/** 从 byteFrom 读到 byteTo 的 UTF-8 文本。尾部不完整行由调用方按换行处理。 */
function readRange(path, byteFrom, byteTo) {
  const len = byteTo - byteFrom;
  if (len <= 0) return '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, byteFrom);
    return buf.toString('utf8', 0, read);
  } catch { return ''; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}
