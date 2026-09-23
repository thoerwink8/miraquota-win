/**
 * 原始来源 → 流水行（账本的唯一输入）。
 *
 * 账本只有一种原料：**一次调用一行**。这里把两份原始记录翻译成同一个形状，别的模块都不再
 * 直接读 `~/.claude/projects` 与 `~/.mirasim/insights`：
 *
 *  - `t` transcript：Claude Code 自己写的会话文件，token 完整、可回溯全部历史，但**会被
 *    Claude Code 的清理删掉**（2026-09-23 实咬：本机 8 天的记录在 10:51 被清空，账本当场
 *    从 ~$2500 掉到 $341）；
 *  - `g` 网关：Mirasim relay 的账本，只有经它走的调用，但**它不会消失**；每台机器的这份
 *    日志只记本机流量（实测：本机与服务器的 id 交集为 0，互不包含）；
 *  - `d` dispatch：Mirasim 自己发的中继调用（起标题、路由），不写会话文件，只有网关有。
 *
 * 两份来源覆盖的是同一批调用的不同子集，**靠 id 对不齐**（transcript 有三分之一的行没有
 * `requestId`，只能退回 `message.id`；网关的 `providerCallId` 是 relay 自己的 id）。所以
 * 流水里两份都留、各自打上 `side`，由 `store.mjs` 的 effective 视图决定"这一小时听谁的"——
 * 换口径是改视图，不再需要清空重建（旧账本正是栽在把聚合态当账本存）。
 *
 * 行形状（所有字段都短名，一天两千行时字节数就是钱）：
 *   { key, src, side, ts, model, effort, i, o, cr, cw, usd, priced, billable, sid, ws, family }
 *
 * **重复读同一个文件是安全的**：store 以 `key` 为主键 upsert 并取较大值，所以游标只影响
 * 性能、不影响正确性。这条是旧账本那些 `seen`/`booked`/`cursors` 状态的替代品——它们曾经
 * 占掉状态文件 75–85% 的体积，就为了防重读。
 */
import { openSync, closeSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isRelayCharged, modelFamily } from './model-families.mjs';

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** 递归收集 .jsonl（子代理会话在更深一层，但都一样读）。 */
export function walkTranscripts(dir, depth, out) {
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) walkTranscripts(p, depth + 1, out);
    else if (it.name.endsWith('.jsonl')) out.push({ path: p, nested: depth > 1 });
  }
  return out;
}

/** 读文件的 [from, to) 字节区间，返回文本（切在换行边界上，避免半个 UTF-8 字符）。 */
export function readRange(path, from, to) {
  const len = to - from;
  if (!(len > 0)) return '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, from);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) { try { closeSync(fd); } catch { /* 已关 */ } }
  }
}

/** 一行流水。字段顺序与注释固定，别随手加——加字段要同时改 store 的 schema 与文档。 */
export function callRow({
  key, src, side, ts, model, effort = null, i = 0, o = 0, cr = 0, cw = 0,
  usd = 0, priced = 1, billable = 1, sid = null, ws = null, family = null, machine = null,
}) {
  return {
    key, src, side, ts, model: model ?? '', effort,
    i, o, cr, cw, usd, priced, billable, sid, ws,
    family: family ?? (model ? modelFamily(model).id : ''),
    machine,
  };
}

/**
 * transcript → 流水行。
 *
 * 一次响应会写成多行（思考/工具调用/正文各一行），它们的 `requestId` 相同而 usage 逐步变大，
 * 所以同一个 key 会被喂多次——store 取较大值，正是这个语义。
 * 无 `requestId` 的行退回 `message.id`（实测占三分之一）。
 *
 * @param opts.root     `~/.claude/projects`
 * @param opts.cutoff   只读这个时刻（秒）之后的记录
 * @param opts.pricing  Pricing 实例（没价的模型 usd=0 且 priced=0）
 * @param opts.machine  本机 id（写进流水，多机汇总时用）
 * @param opts.cursors  { 文件路径: 已读字节 } —— 只影响性能：给了就从那里读，没给读全文件
 */
export function* transcriptRows({ root, cutoff, pricing, machine = null, cursors = null }) {
  const files = walkTranscripts(root, 0, []);
  for (const { path } of files) {
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.mtimeMs / 1000 < cutoff) continue;      // 整个文件早于窗口
    const size = st.size;
    let from = cursors?.[path]?.offset ?? 0;
    if (size < from) from = 0;                     // 被截断，从头读
    if (size <= from) continue;
    const text = readRange(path, from, size);
    if (!text) continue;
    let start = 0, nl;
    while ((nl = text.indexOf('\n', start)) >= 0) {
      const line = text.slice(start, nl);
      start = nl + 1;
      if (!line.includes('"usage"')) continue;
      const row = transcriptLine(line, { cutoff, pricing, machine });
      if (row) yield row;
    }
  }
}

/** 单行 transcript → 流水行（导出给测试与单行重放用）。 */
export function transcriptLine(line, { cutoff = 0, pricing, machine = null } = {}) {
  let root;
  try { root = JSON.parse(line); } catch { return null; }
  const epoch = root.timestamp ? Math.floor(Date.parse(root.timestamp) / 1000) : NaN;
  const usage = root.message?.usage;
  if (!Number.isFinite(epoch) || epoch < cutoff || !usage) return null;
  const model = root.message?.model ?? '';
  const rid = root.requestId ?? root.message?.id;
  if (!rid) return null;                            // 无键无法去重，宁可不记（旧账本同样处理）
  const usd = pricing.cost(model, num(usage.input_tokens), num(usage.output_tokens),
    num(usage.cache_read_input_tokens), num(usage.cache_creation_input_tokens));
  return callRow({
    key: 't:' + rid, src: 't', side: 't', ts: epoch, model,
    i: num(usage.input_tokens), o: num(usage.output_tokens),
    cr: num(usage.cache_read_input_tokens), cw: num(usage.cache_creation_input_tokens),
    usd: usd ?? 0, priced: usd == null ? 0 : 1, billable: 1,
    sid: root.sessionId ?? null, ws: root.cwd ?? null, machine,
  });
}

/**
 * 网关账本 → 流水行。
 *
 * `billable` 记下来但不在这里筛：流水要留全量（分析任务花费时"这次调用有没有走 relay"也是
 * 信息），是否计入由视图决定。旧账本在解析时就丢掉不可计费的整条记录，于是那些调用在
 * 任何报表里都不存在。
 */
export function* gatewayRows({ dir, cutoff, pricing, machine = null }) {
  let files;
  try { files = readdirSync(dir); } catch { return; }
  for (const name of files) {
    if (!name.startsWith('usage-') || !name.endsWith('.ndjson')) continue;
    const path = join(dir, name);
    let text;
    try { text = readRange(path, 0, statSync(path).size); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row = gatewayLine(line, { cutoff, pricing, machine });
      if (row) yield row;
    }
  }
}

/** 单行网关账本 → 流水行。 */
export function gatewayLine(line, { cutoff = 0, pricing, machine = null } = {}) {
  let root;
  try { root = JSON.parse(line); } catch { return null; }
  const epoch = root.ts ? Math.floor(Date.parse(root.ts) / 1000) : NaN;
  if (!Number.isFinite(epoch) || epoch < cutoff) return null;
  const id = root.id;
  if (!id) return null;
  const model = root.model ?? '';
  const dispatch = root.modelSource === 'dispatch';
  const usd = model ? pricing.cost(model, num(root.input), num(root.output),
    num(root.cacheRead), num(root.cacheWrite)) : null;
  return callRow({
    key: (dispatch ? 'd:' : 'g:') + id,
    src: dispatch ? 'd' : 'g', side: 'g', ts: epoch, model,
    effort: root.effort ?? null,
    i: num(root.input), o: num(root.output), cr: num(root.cacheRead), cw: num(root.cacheWrite),
    usd: usd ?? 0, priced: usd == null ? 0 : 1, billable: isRelayCharged(root) ? 1 : 0,
    sid: root.sessionId ?? null,
    ws: root.workspace ?? root.repo ?? null,
    family: dispatch ? 'dispatch' : undefined,     // undefined → 由 modelFamily 推
    machine,
  });
}

/** 各来源的目录约定（默认值集中在这里，调用方与测试都从这一份取）。 */
export function sourcePaths(home) {
  return {
    transcripts: join(home, '.claude', 'projects'),
    gateway: join(home, '.mirasim', 'insights'),
    sessions: join(home, '.mirasim', 'sessions'),
  };
}

/**
 * Mirasim 会话库 → 轮次（任务归属用）。
 *
 * 只取**归属信息**，不取它的 usage 当花费来源：那份 usage 没有缓存写，而缓存读/写占 fable
 * 花费的一半以上；当来源会与 transcript 重复计。任务归属靠 `[startedAt, updatedAt]` 这个
 * 时间区间——一笔调用的 ts 落在哪个轮次里，就归哪个任务。
 *
 * 覆盖有限，必须如实承认：轮次只覆盖 Mirasim 管起来的会话（实测 1201 轮里 1068 轮有 taskId），
 * 所以报表要给"归不上任务"的那部分留一行，而不是把它摊到别的任务头上。
 *
 * @param opts.dir    `~/.mirasim/sessions`（下面按 agent 分子目录）
 * @param opts.cutoff 只读这个时刻（秒）之后还在活动的轮次
 */
export function* turnRows({ dir, cutoff = 0 }) {
  let agents;
  try { agents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const a of agents) {
    if (!a.isDirectory()) continue;
    const agentDir = join(dir, a.name);
    let sessions;
    try { sessions = readdirSync(agentDir, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const path = join(agentDir, s.name, 'turns.jsonl');
      let text;
      try { text = readRange(path, 0, statSync(path).size); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const row = turnLine(line, { cutoff });
        if (row) yield row;
      }
    }
  }
}

/** 单行 turns.jsonl → 轮次行。 */
export function turnLine(line, { cutoff = 0 } = {}) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  const startedAt = Math.floor((o.startedAt ?? o.updatedAt ?? 0) / 1000);
  const endedAt = Math.floor((o.updatedAt ?? o.startedAt ?? 0) / 1000);
  if (!startedAt || endedAt < cutoff) return null;
  if (!o.sessionId) return null;
  return {
    task: o.taskId ?? null,
    sid: o.sessionId,
    startedAt,
    endedAt,
    model: o.model ?? null,
    promptHead: typeof o.prompt === 'string' ? o.prompt.slice(0, 80) : null,
    i: num(o.usage?.inputTokens), o: num(o.usage?.outputTokens), cr: num(o.usage?.cachedInputTokens),
  };
}
