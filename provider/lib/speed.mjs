/**
 * 出字速度与首 token 等待的估计。移植自 Swift 版 SpeedStats.swift（含简化）。
 *
 * 网关账本只记录每次请求的总时长，没有首字节时刻。同一模型上总时长与输出量近似线性：
 * `时长 ≈ 首 token 等待 + 输出量 ÷ 出字速度`。据此分模型回归：截距给首 token，
 * 斜率给基准出字速度；当下出字速度另取最近几次请求，反映此刻而非均值。
 *
 * 数据来源（本机三处）：
 *  1. ~/.mirasim/insights/usage-*.ndjson —— 网关账本。status==200 的请求进池，
 *     字段 durationMs / model / output(token,可能0) / id / providerCallId / ts。
 *     id 形如 `sessionId:callId`，尾段 callId 对得上 diag 事件。
 *  2. ~/.mirasim/diag/ev-*.ndjson —— 诊断事件流。model.begin(POST /v1/messages) 起在途，
 *     model.end 落地移除并给出即时 durationMs。只扫最近两个小时文件。
 *  3. ~/.claude/projects/ ** /*.jsonl —— Claude Code transcript。给账本 output=0 的行补 token：
 *     账本 providerCallId == transcript requestId。
 *
 * 与 Swift 版的简化（按任务要求）：
 *  - 无 OTLP 实测通道（~/.miraquota/measured/ 在 Windows 不存在）：measured 恒 false，只走回归。
 *  - 不产出 sessionRows（report 不放 sessions）。
 *  - 无 planWindows / epochStart 档位过滤（留空实现，全样本可用）。
 *  - 无显示平滑 shownRate：直接用原始 rate。
 *  - 不照抄字节游标：本机文件不大，每轮整读近 48h 再按时间过滤，功能正确优先。
 */
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const INSIGHTS = join(HOME, '.mirasim', 'insights');
const DIAG = join(HOME, '.mirasim', 'diag');
const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects');

// —— 口径常量（照抄 Swift）——
const RETENTION = 48 * 3600;      // 样本保留时长，秒
const MIN_DURATION = 200;         // 过短请求既不稳也拉偏截距，进池下限（ms）
const MIN_OUTPUT = 32;            // token 进池下限
const MIN_SEPARATION = 32;        // 回归配对两端输出量差下限
const MIN_PAIRS = 6;              // 给出斜率所需最少配对数（即最少 12 条样本）
const MIN_ROW = 1;                // 单模型成行最少样本数
const RECENT_COUNT = 5;           // 出字速度取最近这么多次请求
const RECENCY_LIMIT = 2 * 3600;   // 超过这么久没请求就不再成行，秒
const MIN_STREAM_SECONDS = 0.25;  // 样本进速率统计所需最短出字时间
const RATE_MIN = 5.0;             // 速率合理带
const RATE_MAX = 1000.0;
const FLIGHT_CAP = 600;           // 在途条目保留上限，秒（超时视为被中断的泄漏）
const DIAG_RECENT_FILES = 2;      // 只扫最近这么多个 diag 小时文件
const TRANSCRIPT_TAIL = 1 << 20;  // transcript 只读尾部这么多字节

const toInt = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; }
  return null;
};

const epochSeconds = (ts) => {
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

const median = (v) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** 读整个文件；文件过大时只读尾部 tail 字节（起点多半落在半行中间，调用方跳首行）。 */
function readTail(path, tail) {
  const size = statSync(path).size;
  if (tail && size > tail) {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(tail);
      const n = readSync(fd, buf, 0, tail, size - tail);
      return { text: buf.toString('utf8', 0, n), partial: true };
    } finally { closeSync(fd); }
  }
  return { text: readFileSync(path, 'utf8'), partial: false };
}

function* ndjsonLines(text, skipFirst) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (skipFirst && i === 0) continue;
    const line = lines[i];
    if (line.length > 2) yield line;
  }
}

/** 递归收集 .jsonl 及其 mtime（子代理会话在更深一层）。 */
function walkTranscripts(dir, out) {
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) walkTranscripts(p, out);
    else if (it.name.endsWith('.jsonl')) {
      try { out.push({ path: p, mtimeMs: statSync(p).mtimeMs }); } catch { /* 竞态删除，跳过 */ }
    }
  }
}

/**
 * 展示名：去掉 `claude-` 前缀与快照日期后缀，族名首字母大写，版本号用点连接。
 * `claude-opus-5` → `Opus 5`，`claude-opus-4-8` → `Opus 4.8`，
 * `claude-haiku-4-5-20251001` → `Haiku 4.5`。版本段非纯数字时（`gpt-5.6-sol` 一类）原样保留。
 */
function shortName(model) {
  if (!model) return '未知';
  let name = model;
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);      // 剥 provider 前缀
  if (name.startsWith('claude-')) name = name.slice(7);
  if (!name) return model;                            // 只剩前缀，退回原名
  const parts = name.split('-');
  const last = parts[parts.length - 1];
  if (last && last.length === 8 && /^[0-9]+$/.test(last)) parts.pop();  // 剥快照日期后缀
  const family = parts[0];
  if (!family) return name;
  const version = parts.slice(1);
  if (!version.length || !version.every((p) => p.length > 0 && /^[0-9]+$/.test(p))) return name;
  return family[0].toUpperCase() + family.slice(1) + ' ' + version.join('.');
}

/** 当下相对常态的偏离，百分比。基准缺失时为 null。 */
function driftOf(rate, baselineRate) {
  if (rate == null || baselineRate == null || !(baselineRate > 0)) return null;
  return (rate - baselineRate) / baselineRate * 100;
}

/**
 * 偏离是否够格显示。三个闸门：样本 ≥3、幅度过线、当下值不超过基准三倍。
 * 幅度阈值分进出两档（迟滞）：进 25% / 出 18%，否则边界处逐轮闪烁。
 */
function driftPasses(samples, rate, baselineRate, shown) {
  if (samples < 3) return null;
  const d = driftOf(rate, baselineRate);
  if (d == null || rate == null || baselineRate == null) return null;
  if (!(rate <= baselineRate * 3)) return null;
  return Math.abs(d) >= (shown ? 18 : 25) ? d : null;
}

export class SpeedStats {
  constructor() {
    /** id → 样本 {id, at, out, ms, model, callId, requestId} */
    this.samples = new Map();
    /** callId → 开始时刻（unix 秒），在途请求 */
    this.flights = new Map();
    /** callId → 即时 durationMs（来自 diag model.end） */
    this.diagDurations = new Map();
    /** requestId → output_tokens（来自 transcript） */
    this.transcriptTokens = new Map();
    /** 当前正在显示偏离提示的模型短名（迟滞状态） */
    this.driftShown = new Set();
    /** 额度档位组：provider 会声明，本移植做成记录但不参与过滤 */
    this.scopedGroups = [];
    this.lastScan = { bytes: 0, lines: 0, parsed: 0, cutoff: 0 };
  }

  /**
   * 声明额度档位组。本移植砍掉了档位过滤，此处只记录、不参与估计，保证 provider 调用不报错。
   */
  adoptScopedGroups(groups) {
    this.scopedGroups = (Array.isArray(groups) ? groups : [])
      .map((g) => String(g || '').toLowerCase()).filter((g) => g.length > 0).sort();
  }

  /** 每轮增量刷新：整读近 48h 账本 + 最近 diag，再用 transcript / diag 补齐 token 与时长。 */
  refresh(now = Date.now()) {
    const nowSec = Math.floor(now / 1000);
    const cutoff = nowSec - RETENTION;
    this.scanLedger(cutoff);
    this.scanDiag(nowSec);
    this.backfillFromTranscripts();
    // diag 的即时时长优先：账本时长可能先落粗值，请求完成即写的 diag 更贴当下。
    for (const s of this.samples.values()) {
      const ms = this.diagDurations.get(s.callId);
      if (ms != null && ms > 0) s.ms = ms;
    }
    // 修剪保留期外的样本与在途条目。
    for (const [id, s] of this.samples) if (s.at < cutoff) this.samples.delete(id);
    const flightCutoff = nowSec - FLIGHT_CAP;
    for (const [cid, at] of this.flights) if (at < flightCutoff) this.flights.delete(cid);
  }

  /**
   * 账本不是追加型：token 由 relay 事后回填、历史行原地改写。故每轮整读、按 id 去重、
   * 以最新读到的值为准。落盘时 output 可能为 0，这里不按 token 筛，只取关联键，token 随后补齐。
   */
  scanLedger(cutoff) {
    let files;
    try { files = readdirSync(INSIGHTS); } catch { return; }
    const seen = new Map();
    let bytes = 0, lines = 0, parsed = 0;
    for (const name of files) {
      if (!name.startsWith('usage-') || !name.endsWith('.ndjson')) continue;
      let text;
      try { text = readFileSync(join(INSIGHTS, name), 'utf8'); } catch { continue; }
      bytes += Buffer.byteLength(text);
      for (const line of ndjsonLines(text, false)) {
        if (line.indexOf('"durationMs"') < 0) continue;
        lines++;
        const s = parseUsage(line, cutoff);
        if (s) { parsed++; seen.set(s.id, s); }
      }
    }
    this.samples = seen;
    this.lastScan = { bytes, lines, parsed, cutoff };
  }

  /**
   * Mirasim 诊断事件流按小时一个文件，model.begin 在请求发出瞬间写入——本机唯一能实时看到
   * 「请求在途」的地方。只扫最近两个文件，跨小时的 end 也接得上。整读重放：begin 起、end 落。
   */
  scanDiag(nowSec) {
    let files;
    try { files = readdirSync(DIAG); } catch { return; }
    const recent = files
      .filter((n) => n.startsWith('ev-') && n.endsWith('.ndjson'))
      .sort()
      .slice(-DIAG_RECENT_FILES);
    // 每轮从头重建：在途集合与即时时长都由重放这两个文件得出，无需字节游标。
    this.flights = new Map();
    this.diagDurations = new Map();
    for (const name of recent) {
      let text;
      try { text = readFileSync(join(DIAG, name), 'utf8'); } catch { continue; }
      for (const line of ndjsonLines(text, false)) {
        if (line.indexOf('"kind":"model.') < 0) continue;
        let root;
        try { root = JSON.parse(line); } catch { continue; }
        const callId = root.callId;
        if (typeof callId !== 'string') continue;
        if (root.kind === 'model.begin') {
          // 只认生成请求。count_tokens 与 /v1/limits 的探测也产生事件对，不算在途。
          if (root.method !== 'POST') continue;
          const path = typeof root.path === 'string' ? root.path : '';
          if (path.split('?')[0] !== '/v1/messages') continue;
          const at = epochSeconds(root.ts);
          if (at == null) continue;
          this.flights.set(callId, at);
        } else if (root.kind === 'model.end') {
          this.flights.delete(callId);
          const ms = toInt(root.durationMs);
          if (ms != null && ms > 0) this.diagDurations.set(callId, ms);
        }
      }
    }
  }

  /**
   * 从 Claude Code transcript 尾部取 token，给账本 output=0 的样本补齐。
   * transcript 追加型、请求完成即写，是「当下」token 的即时来源。
   * 关联键：账本 providerCallId == transcript requestId。
   */
  backfillFromTranscripts() {
    const wanted = new Set();
    for (const s of this.samples.values()) {
      if (s.out < MIN_OUTPUT && s.requestId) wanted.add(s.requestId);
    }
    if (wanted.size) this.scanTranscripts(wanted);
    for (const s of this.samples.values()) {
      if (s.out < MIN_OUTPUT) {
        const n = this.transcriptTokens.get(s.requestId);
        if (n != null && n > 0) s.out = n;
      }
    }
  }

  scanTranscripts(wanted) {
    const found = [];
    walkTranscripts(CLAUDE_PROJECTS, found);
    // 只读最近活跃的会话文件（token 缺口都在新近请求上），按 mtime 取前若干个。
    const active = Date.now() - RETENTION * 1000;
    const recent = found.filter((e) => e.mtimeMs >= active)
      .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 24);
    for (const e of recent) {
      let read;
      try { read = readTail(e.path, TRANSCRIPT_TAIL); } catch { continue; }
      for (const line of ndjsonLines(read.text, read.partial)) {
        if (line.indexOf('output_tokens') < 0 || line.indexOf('requestId') < 0) continue;
        let root;
        try { root = JSON.parse(line); } catch { continue; }
        const rid = root.requestId;
        if (typeof rid !== 'string' || !wanted.has(rid)) continue;
        const usage = root.message && root.message.usage;
        const out = usage ? toInt(usage.output_tokens) : null;
        if (out == null || out <= 0) continue;
        // fork / resume 会复制同一条记录，取较大值即可。
        this.transcriptTokens.set(rid, Math.max(this.transcriptTokens.get(rid) || 0, out));
      }
    }
  }

  /** token 与时长的下限统一在此把关：凡进入估计的样本都必须过这道门。 */
  usable() {
    const out = [];
    for (const s of this.samples.values()) {
      if (s.out >= MIN_OUTPUT && s.ms >= MIN_DURATION) out.push(s);
    }
    return out;
  }

  /**
   * 保留期内全部样本的回归：斜率给出字速度基准，截距给首 token。
   * 确定性的 Theil–Sen 变体：按输出量排序后取跨半程配对的斜率中位数，对离群时长不敏感。
   * 输出量相同的样本按时长再排一次（保证配对顺序稳定，中位数不随运行漂移）。
   */
  regress(group) {
    const sorted = [...group].sort((a, b) => (a.out !== b.out ? a.out - b.out : a.ms - b.ms));
    const half = sorted.length >> 1;
    const slopes = [];
    for (let i = 0; i < half; i++) {
      const dx = sorted[i + half].out - sorted[i].out;
      if (dx < MIN_SEPARATION) continue;
      slopes.push((sorted[i + half].ms - sorted[i].ms) / dx);
    }
    if (slopes.length < MIN_PAIRS) return { rate: null, ttft: null };
    const b = median(slopes);
    if (b == null || !(b > 0)) return { rate: null, ttft: null };
    const rate = 1000 / b;
    if (rate < RATE_MIN || rate > RATE_MAX) return { rate: null, ttft: null };
    // 截距为负说明线性关系在这批样本上不成立，此时不给首 token。
    const a = median(sorted.map((s) => s.ms - b * s.out));
    if (a == null || a < 0) return { rate, ttft: null };
    return { rate, ttft: a / 1000 };
  }

  /**
   * 按模型给出「最近几次」的速度。`group` 是某模型保留期内的全部样本：
   * 回归取全部，出字速度只取最近几次；最近一次请求早于 fresh 的模型不成行。
   */
  estimate(group, fresh) {
    const byTime = [...group].sort((a, b) => a.at - b.at);
    const newest = byTime[byTime.length - 1];
    if (!newest || newest.at < fresh) return null;
    const recent = byTime.slice(-RECENT_COUNT).filter((s) => s.at >= fresh);
    if (recent.length < MIN_ROW) return null;

    const { rate: baselineRate, ttft } = this.regress(group);

    const outSum = recent.reduce((a, s) => a + s.out, 0);
    const msSum = recent.reduce((a, s) => a + s.ms, 0);
    // 端到端与出字速度同口径（都按 token 加权），否则会出现「端到端比出字速度还快」的矛盾。
    const endToEnd = msSum > 0 ? outSum / (msSum / 1000) : 0;

    // 首 token 无法逐次测量，用回归值从每条请求时长里扣掉，余下的才是出字时间；按 token 加权。
    let rate = null;
    if (ttft != null) {
      const streaming = recent.filter((s) => s.ms / 1000 - ttft >= MIN_STREAM_SECONDS);
      const seconds = streaming.reduce((a, s) => a + s.ms / 1000 - ttft, 0);
      if (seconds > 0) {
        const r = streaming.reduce((a, s) => a + s.out, 0) / seconds;
        if (r >= RATE_MIN && r <= RATE_MAX) rate = r;
      }
    }

    const key = shortName(newest.model);
    const shown = this.driftShown.has(key);
    const driftNotable = driftPasses(recent.length, rate, baselineRate, shown);
    if (driftNotable == null) this.driftShown.delete(key); else this.driftShown.add(key);

    return {
      model: key,
      samples: recent.length,
      ttft: ttft,
      rate: rate,
      endToEnd: endToEnd,
      baselineRate: baselineRate,
      drift: driftOf(rate, baselineRate),
      driftNotable: driftNotable,
      latestAt: newest.at,
      measured: false,
    };
  }

  /** 两路样本都空且无在途时返回 null，界面据此整卡隐藏。 */
  report(now = Date.now()) {
    const nowSec = Math.floor(now / 1000);
    const pool = this.usable();
    if (pool.length === 0 && this.flights.size === 0) return null;
    const fresh = nowSec - RECENCY_LIMIT;

    const byModel = new Map();
    for (const s of pool) {
      if (!byModel.has(s.model)) byModel.set(s.model, []);
      byModel.get(s.model).push(s);
    }

    const rows = [];
    for (const group of byModel.values()) {
      const row = this.estimate(group, fresh);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => b.latestAt - a.latestAt);
    const top = rows.slice(0, 3).map(pruneRow);

    const sampleTotal = pool.filter((s) => s.at >= fresh).length;
    const inflightSince = [...this.flights.values()].sort((a, b) => a - b);

    return {
      rows: top,
      recentCount: RECENT_COUNT,
      sampleTotal,
      inflightSince,
      measuredTurnTTFB: null,
    };
  }
}

/** 账本行 → 样本。status==200、时长与模型齐备、时刻不早于下界。token 允许为 0，随后补齐。 */
function parseUsage(line, cutoff) {
  let root;
  try { root = JSON.parse(line); } catch { return null; }
  if (root.status !== 200) return null;
  const at = epochSeconds(root.ts);
  if (at == null || at < cutoff) return null;
  const ms = toInt(root.durationMs);
  if (ms == null) return null;
  const model = typeof root.model === 'string' ? root.model : '';
  if (!model) return null;
  const id = (typeof root.id === 'string' && root.id) ? root.id : root.ts;
  const idParts = id.split(':');
  return {
    id,
    at,
    out: toInt(root.output) ?? 0,
    ms,
    model,
    callId: idParts.length ? idParts[idParts.length - 1] : '',
    requestId: typeof root.providerCallId === 'string' ? root.providerCallId : '',
  };
}

/** 缺失字段省略（null/undefined 不进对象），照任务口径「字段名照抄，缺失省略」。 */
function pruneRow(row) {
  const out = { model: row.model, samples: row.samples };
  if (row.ttft != null) out.ttft = row.ttft;
  if (row.rate != null) out.rate = row.rate;
  out.endToEnd = row.endToEnd;
  if (row.baselineRate != null) out.baselineRate = row.baselineRate;
  if (row.drift != null) out.drift = row.drift;
  if (row.driftNotable != null) out.driftNotable = row.driftNotable;
  out.latestAt = row.latestAt;
  out.measured = false;
  return out;
}
