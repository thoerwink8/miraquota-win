/**
 * fleet-dao 额度表：所有账号池 × 窗口的唯一来源，MiraQuota 是它的桌面窗口（2026-09-24）。
 *
 * 接口约定（全文与语义见 https://github.com/thoerwink8/miraquota-win/pull/3 正文，后端照它实现）：
 *   GET <地址>/api/quota
 *   Authorization: Bearer <只读令牌>        ← 只能读额度，别的接口一律不认它
 *   200 → { schema: 1, asOf, staleAfterMinutes, pools: [...] }
 * `pools` 的每一行就是 fleet-dao 仓 `packages/db/src/queries/quota.ts` 里 `quotaTable()` 的一行
 * （QuotaTablePool / QuotaTableWindow，时间转成 ISO 字符串）——字段名、取值、「上游这次没报」
 * （staleSince）、「从没读成」（neverRead）都照它，两边不一致就回来改这里。多出来的字段不看。
 * 配置：~/.miraquota/fleet.json { url, token }，面板「账号池」页填，存本机、不进仓库。
 *
 * 改这里之前要知道的三条：
 *  1. **没读成就说没读成**：连不上、401、回包认不出、fleet.json 坏了，都是带 code 与人话的明确失败，
 *     不许用空列表冒充「查了没事」。上一份好数据留着（只进不退），但状态里写清它是多久以前的；
 *     「上游明说 0 个池 / 0 个窗口」与「没读成」是两回事，形状上就分得开。
 *  2. **时间一律换成本机钟**：按「本机收到时刻 − 服务端 asOf」校一次钟差，龄期与清零倒计时
 *     才不被两台机器的时钟差带偏。
 *  3. **令牌不出这个模块**：状态、payload、报错里都没有它；它只在 fleet.json 与请求头里。
 *     读配置时就验它只含可见字符（带换行的令牌会让 fetch 把整个请求头连令牌一起写进报错）；
 *     报错文本再按令牌原文脱敏一遍兜底。跳转一律不跟（redirect: manual）——跟过去就是把令牌带给别的主机。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const FLEET_CONFIG = join(homedir(), '.miraquota', 'fleet.json');
/** 秒；读 fleet-dao 的间隔。它自己按分钟级节奏读上游，这边再密也只是读到同一份。 */
export const FLEET_POLL_SEC = 60;
/** 本客户端认得的约定版本。回包版本更高＝后端改了形状，要升级 MiraQuota，不猜着读。 */
export const QUOTA_SCHEMA = 1;
const FETCH_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_TEXT = 300;

/** fleet-dao 的 QuotaUnit（只增不改）。认不出的单位不丢窗口，只显示百分比并点名。 */
const UNITS = new Set(['percent', 'usd', 'tokens', 'points']);
const READINGS = new Set(['measured', 'estimated']);
const STATUSES = new Set(['allowed', 'warning', 'limit_reached']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** 令牌只许可见 ASCII：空白、换行、控制字符进了请求头，fetch 会把整行连令牌写进报错。 */
const TOKEN_RE = /^[\x21-\x7e]{8,512}$/;

const clip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isoSec = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms / 1000 : null;
};
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** null 与缺席同义（quotaTable 给 null，手写的回包常省略）。 */
const given = (v) => v !== undefined && v !== null;

/** 令牌格式对不对；不对时给一句不回显令牌本身的原因。 */
export function tokenProblem(token) {
  if (typeof token !== 'string' || !token) return '令牌是空的';
  if (TOKEN_RE.test(token)) return null;
  if (/\s/.test(token)) return '令牌里有空白或换行，多半是粘多了';
  return '令牌里有不可见字符或长度不对';
}

/**
 * 用户填的地址 → 规整成接口根（去掉末尾斜杠、顺手去掉多粘的 /api 或 /api/quota）。
 * 明文 http 只许回环地址（本地假服务器）：令牌是 Bearer，走明文等于在路上裸奔。
 * @returns { ok: true, url } | { ok: false, error }
 */
export function normalizeBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return { ok: false, error: '地址不像一个网址（要以 https:// 开头）' }; }
  if (u.username || u.password) return { ok: false, error: '地址里不要带用户名或口令，令牌填在下面那一栏' };
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    return { ok: false, error: '地址要以 https:// 开头（明文 http 只允许本机测试地址）' };
  }
  if (u.search || u.hash) return { ok: false, error: '地址里不要带 ? 或 # 后面的部分' };
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api(\/quota)?$/, '');
  return { ok: true, url: `${u.protocol}//${u.host}${path}` };
}

/**
 * 一个窗口（QuotaTableWindow）→ 本机形状。
 * 认不出身份（label / readAt / reading）就整格丢并返回 { problem }；只是某个可选字段认不出
 * （新单位、新状态字）就留下这一格、把那一项拿掉，并在 notes 里点名——都不静默。
 * @param skew 本机钟 − 服务端钟（秒），所有时刻都加上它
 */
function parseWindow(w, skew) {
  if (!isObj(w)) return { problem: '窗口不是对象' };
  const label = typeof w.label === 'string' ? w.label.trim() : '';
  if (!label) return { problem: '窗口缺 label' };
  const bad = (why) => ({ problem: `窗口 ${clip(label)}：${why}` });
  if (typeof w.window !== 'string' || !w.window) return bad('缺 window');
  if (!READINGS.has(w.reading)) return bad(`reading 只认 measured / estimated，收到 ${clip(w.reading)}`);
  const readAt = isoSec(w.readAt);
  if (readAt == null) return bad('readAt 不是时间');
  for (const k of ['utilization', 'used', 'limit']) {
    if (given(w[k]) && !finite(w[k])) return bad(`${k} 不是数`);
  }
  const notes = [];
  let resetsAt = null;
  if (given(w.resetsAt)) {
    resetsAt = isoSec(w.resetsAt);
    if (resetsAt == null) notes.push(`窗口 ${clip(label)}：resetsAt 不是时间，不给倒计时`);
  }
  let staleSince = null;
  if (given(w.staleSince)) {
    staleSince = isoSec(w.staleSince);
    if (staleSince == null) return bad('staleSince 不是时间');
  }
  const unitKnown = UNITS.has(w.unit);
  if (!unitKnown) notes.push(`窗口 ${clip(label)}：单位 ${clip(w.unit)} 这个客户端还不认，只显示百分比`);
  const statusKnown = !given(w.upstreamStatus) || STATUSES.has(w.upstreamStatus);
  if (!statusKnown) notes.push(`窗口 ${clip(label)}：上游状态 ${clip(w.upstreamStatus)} 认不出，原字放在悬停里`);
  const utilization = given(w.utilization) ? w.utilization
    : unitKnown && given(w.used) && finite(w.limit) && w.limit > 0 ? w.used / w.limit : null;
  if (utilization == null && !(statusKnown && given(w.upstreamStatus))) {
    return bad('既没有用量也没有上游状态，这一格什么都说明不了');
  }
  return {
    notes,
    window: {
      label, window: w.window,
      ...(typeof w.scope === 'string' && w.scope ? { scope: w.scope } : {}),
      ...(utilization != null ? { utilization } : {}),
      // 单位认不出时数字没法说清是什么，只留百分比
      ...(unitKnown && given(w.used) ? { used: w.used } : {}),
      ...(unitKnown && given(w.limit) ? { limit: w.limit } : {}),
      unit: unitKnown ? w.unit : 'unknown',
      ...(resetsAt != null ? { resetsAt: resetsAt + skew } : {}),
      ...(statusKnown && given(w.upstreamStatus) ? { upstreamStatus: w.upstreamStatus } : {}),
      ...(typeof w.statusRaw === 'string' && w.statusRaw ? { statusRaw: clip(w.statusRaw) }
        : !statusKnown ? { statusRaw: clip(w.upstreamStatus) } : {}),
      reading: w.reading,
      source: typeof w.source === 'string' ? w.source : '',
      readAt: readAt + skew,
      ...(staleSince != null ? { staleSince: staleSince + skew } : {}),
    },
  };
}

/**
 * 一个池（QuotaTablePool）→ 本机形状。池本身认不出时保留一行 { poolId?, name, problem }，界面照样给它一格。
 * 展示名：回包给了 name 用 name；否则用渠道名，同渠道有好几个池时后面挂上池编号（两个 Claude 组织）。
 */
function parsePool(p, skew, index, sameChannel) {
  const fallback = `第 ${index + 1} 个池`;
  if (!isObj(p)) return { poolId: `#${index + 1}`, name: fallback, problem: '池不是对象', windows: [], notes: [] };
  const poolId = typeof p.poolId === 'string' && p.poolId ? p.poolId : null;
  const channelName = typeof p.channelName === 'string' && p.channelName.trim() ? clip(p.channelName) : '';
  const name = typeof p.name === 'string' && p.name.trim() ? clip(p.name)
    : channelName ? (sameChannel(p.channelId) > 1 && poolId ? `${channelName} · ${poolId}` : channelName)
      : (poolId ?? fallback);
  const shell = { poolId: poolId ?? `#${index + 1}`, name, windows: [], notes: [] };
  if (!poolId) return { ...shell, problem: '池缺 poolId' };
  if (!Array.isArray(p.windows)) return { ...shell, problem: 'windows 不是数组' };
  if (typeof p.neverRead !== 'boolean') return { ...shell, problem: '缺 neverRead（从没读成过要明说，不能用空窗口冒充）' };
  let lastReadOkAt = null;
  if (given(p.lastReadOkAt)) {
    lastReadOkAt = isoSec(p.lastReadOkAt);
    if (lastReadOkAt == null) return { ...shell, problem: 'lastReadOkAt 不是时间' };
    lastReadOkAt += skew;
  }
  let lastError = null;
  if (isObj(p.lastError)) {
    const at = isoSec(p.lastError.at);
    lastError = {
      code: clip(p.lastError.code) || 'unknown', message: clip(p.lastError.message) || '后端没说原因',
      ...(at != null ? { at: at + skew } : {}),
    };
  }

  const windows = [];
  const notes = [];
  const seen = new Set();
  for (const raw of p.windows) {
    const r = parseWindow(raw, skew);
    if (r.problem) { notes.push(r.problem); continue; }
    if (seen.has(r.window.label)) { notes.push(`窗口 ${clip(r.window.label)} 出现了两次，只留第一条`); continue; }
    seen.add(r.window.label);
    windows.push(r.window);
    notes.push(...r.notes);
  }
  const expiresAt = given(p.expiresAt) ? isoSec(p.expiresAt) : null;
  return {
    poolId, name,
    channelId: typeof p.channelId === 'string' ? p.channelId : '',
    neverRead: p.neverRead,
    readOverdue: p.readOverdue === true,
    lastReadOkAt,
    ...(lastError ? { lastError } : {}),
    ...(expiresAt != null ? { expiresAt: expiresAt + skew } : {}),
    notes,
    windows,
  };
}

/**
 * GET /api/quota 的回包 → 本机形状。顶层认不出（不是对象、版本不对、缺 asOf / pools）整份拒收；
 * 单个池或窗口认不出只影响它自己，并记进 problem / notes 给界面说出来。
 * @param receivedAt 本机收到回包的时刻（秒），用来校钟差
 * @returns { ok: true, report } | { ok: false, error }
 */
export function parseQuotaReport(body, receivedAt = Date.now() / 1000) {
  if (!isObj(body)) return { ok: false, error: '回包不是 JSON 对象' };
  if (body.schema !== QUOTA_SCHEMA) {
    return finite(body.schema) && body.schema > QUOTA_SCHEMA
      ? { ok: false, error: `回包是第 ${body.schema} 版约定，这个 MiraQuota 只认第 ${QUOTA_SCHEMA} 版——升级 MiraQuota` }
      : { ok: false, error: `回包缺 schema 或版本不对（要 ${QUOTA_SCHEMA}）` };
  }
  const asOf = isoSec(body.asOf);
  if (asOf == null) return { ok: false, error: '回包缺 asOf（服务端生成这份回包的时刻）' };
  if (!finite(body.staleAfterMinutes) || body.staleAfterMinutes <= 0) return { ok: false, error: '回包缺 staleAfterMinutes' };
  if (!Array.isArray(body.pools)) return { ok: false, error: '回包缺 pools 数组' };
  const skew = receivedAt - asOf;
  const perChannel = new Map();
  for (const p of body.pools) if (isObj(p)) perChannel.set(p.channelId, (perChannel.get(p.channelId) ?? 0) + 1);
  const sameChannel = (id) => perChannel.get(id) ?? 0;
  return {
    ok: true,
    report: {
      schema: body.schema,
      asOf: receivedAt,
      skewSec: skew,
      staleAfterSec: body.staleAfterMinutes * 60,
      pools: body.pools.map((p, i) => parsePool(p, skew, i, sameChannel)),
    },
  };
}

/** 一次 HTTP 读取的失败 → { code, message }。人话在前，服务端原文截断附后。 */
async function httpFailure(r) {
  let msg = '';
  try { const j = await r.json(); msg = clip(j?.error?.message ?? j?.error ?? ''); } catch { /* 非 JSON */ }
  if (r.status === 401) return { code: 'auth', message: '令牌不对或已吊销（在「账号池」页重新填）' };
  if (r.status === 403) return { code: 'forbidden', message: '这把令牌没有读额度的权限（要一把只读额度的令牌）' };
  if (r.status === 404) return { code: 'not_found', message: '这个地址上没有 /api/quota（后端还没上线，或地址填错了）' };
  if (r.status >= 300 && r.status < 400) {
    let where = '';
    try { where = new URL(r.headers.get('location') ?? '', r.url).origin; } catch { /* 没给去处 */ }
    return { code: 'config', message: `地址会跳转（HTTP ${r.status}${where ? ' → ' + where : ''}），请直接填跳转后的地址` };
  }
  return { code: 'upstream', message: `fleet-dao 报错 HTTP ${r.status}${msg ? '：' + msg : ''}` };
}

/**
 * 读一次。永不抛：成功返回 { ok: true, report }，失败返回 { ok: false, error: { code, message } }。
 * 失败的 message 按令牌原文脱敏：网络层、服务端回的原文里万一带了它，也不往外送。
 * @param fetchImpl 测试注入
 */
export async function fetchQuota(base, token, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, now = () => Date.now() / 1000 } = {}) {
  const scrub = (e) => ({ ...e, message: token ? e.message.split(token).join('***') : e.message });
  const tp = tokenProblem(token);
  if (tp) return { ok: false, error: { code: 'config', message: tp } };
  let r;
  try {
    r = await fetchImpl(`${base}/api/quota`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'miraquota' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = e?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, error: { code: 'timeout', message: `连 fleet-dao 超时（${Math.round(timeoutMs / 1000)} 秒没回）` } };
    }
    const why = clip(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e);
    return { ok: false, error: scrub({ code: 'unreachable', message: `连不上 fleet-dao${why ? '：' + why : ''}` }) };
  }
  if (!r.ok) return { ok: false, error: scrub(await httpFailure(r)) };
  let body;
  try { body = await r.json(); } catch { return { ok: false, error: { code: 'bad_response', message: '回包不是 JSON' } }; }
  const parsed = parseQuotaReport(body, now());
  if (!parsed.ok) return { ok: false, error: scrub({ code: 'bad_response', message: `回包不符合约定：${parsed.error}` }) };
  return parsed;
}

export class FleetSource {
  /**
   * @param opts.configFile  配置路径（测试注入，默认 ~/.miraquota/fleet.json）
   * @param opts.intervalSec 读取间隔（默认 60 秒）
   * @param opts.fetchImpl   测试注入
   * @param opts.onUpdate    每次读完（成败都算）回调：面板据此立刻重画，不等心跳
   */
  constructor({ configFile = FLEET_CONFIG, intervalSec = FLEET_POLL_SEC, fetchImpl = globalThis.fetch,
    onUpdate = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    this.configFile = configFile;
    this.intervalSec = intervalSec;
    this.fetchImpl = fetchImpl;
    this.onUpdate = onUpdate;
    this.timeoutMs = timeoutMs;
    this.#reset();
    this.#config = this.#readConfig();
  }

  #config = null;
  #inflight = null;

  #reset() {
    this.report = null;        // 最近一份读成的（只进不退：一次失败不把它清掉）
    this.fetchedAt = null;     // 那一份是本机什么时刻收到的
    this.lastAttemptAt = null;
    this.lastError = null;     // 最近一次读取失败的 { code, message }；读成后清空
    this.failStreak = 0;
  }

  /**
   * fleet.json → { url, token } | { broken, url? }（文件在但坏了）| null（没配）。
   * 坏了不当「没配」：那样用户只看见「接上」那张卡，不知道原来的配置哪去了。原因里不回显令牌。
   */
  #readConfig() {
    let c;
    try { c = JSON.parse(readFileSync(this.configFile, 'utf8')); } catch (e) {
      return e?.code === 'ENOENT' ? null : { broken: `${this.configFile} 读不出来（不是 JSON？）——在「账号池」页重新填` };
    }
    const u = normalizeBaseUrl(c?.url);
    if (!u.ok) return { broken: `fleet.json 里的地址不对：${u.error}` };
    const token = typeof c?.token === 'string' ? c.token.trim() : '';
    const tp = tokenProblem(token);
    if (tp) return { broken: `fleet.json 里的${tp}——在「账号池」页重新填`, url: u.url };
    return { url: u.url, token };
  }

  get enabled() { return !!this.#config && !this.#config.broken; }
  get url() { return this.#config?.url ?? null; }

  /** 真读一次；同一时刻只有一个在路上（重复调用拿到同一个 Promise）。没配或配坏了返回 null。 */
  refresh() {
    if (!this.enabled) return Promise.resolve(null);
    if (this.#inflight) return this.#inflight;
    const { url, token } = this.#config;
    this.lastAttemptAt = Date.now() / 1000;
    this.#inflight = fetchQuota(url, token, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs })
      .then((r) => {
        // 读的过程中被断开或换了地址：这份结果不属于现在的配置，丢掉
        if (this.#config?.url !== url || this.#config?.token !== token) return r;
        if (r.ok) {
          this.report = r.report;
          this.fetchedAt = Date.now() / 1000;
          this.lastError = null;
          this.failStreak = 0;
        } else {
          this.lastError = r.error;
          this.failStreak += 1;
        }
        return r;
      })
      .finally(() => {
        this.#inflight = null;
        try { this.onUpdate?.(); } catch { /* 画面没准备好，下一跳再画 */ }
      });
    return this.#inflight;
  }

  /** 到点才读（poll 每跳都会调，不等它）。 */
  maybeRefresh(nowSec = Date.now() / 1000) {
    if (!this.enabled || this.#inflight) return;
    if (this.lastAttemptAt != null && nowSec - this.lastAttemptAt < this.intervalSec) return;
    this.refresh().catch(() => { /* fetchQuota 不抛，这里兜底防未处理拒绝 */ });
  }

  /**
   * 面板上「连上」：先按填的地址与令牌真读一次，读成了才写 fleet.json（错在哪一步说哪一步，
   * 写完才发现令牌不对，用户看到的会是「没读成」而不是「令牌填错了」）。
   * @returns { ok: true, pools } | { ok: false, code, error }
   */
  async connect({ url, token } = {}) {
    const u = normalizeBaseUrl(url);
    if (!u.ok) return { ok: false, code: 'config', error: u.error };
    const t = typeof token === 'string' ? token.trim() : '';
    const tp = tokenProblem(t);
    if (tp) return { ok: false, code: 'config', error: tp };
    const r = await fetchQuota(u.url, t, { fetchImpl: this.fetchImpl, timeoutMs: Math.max(this.timeoutMs, CONNECT_TIMEOUT_MS) });
    if (!r.ok) return { ok: false, code: r.error.code, error: r.error.message };
    try {
      mkdirSync(dirname(this.configFile), { recursive: true });
      writeFileSync(this.configFile, JSON.stringify({ url: u.url, token: t }, null, 2) + '\n', { mode: 0o600 });
    } catch (e) { return { ok: false, code: 'config', error: `配置写不进去：${clip(e.message)}` }; }
    this.#reset();
    this.#config = { url: u.url, token: t };
    this.report = r.report;
    this.fetchedAt = Date.now() / 1000;
    this.lastAttemptAt = this.fetchedAt;
    try { this.onUpdate?.(); } catch { /* 同上 */ }
    return { ok: true, pools: r.report.pools.length };
  }

  /** 断开：删掉 fleet.json，清掉内存里的读数。删不掉就如实说。 */
  disconnect() {
    try { rmSync(this.configFile, { force: true }); } catch (e) { return { ok: false, error: `删不掉 ${this.configFile}：${clip(e.message)}` }; }
    this.#config = null;
    this.#reset();
    return { ok: true };
  }

  /**
   * 哪个池替补本机 Mirasim：窗口由 mirasim-relay 读出来的池**恰好一个**才用（回包里没有「读法」
   * 这一列，窗口的 source 就是读法）。额度点是账号级的，同一个账号谁读到都一样；有两个就认不出
   * 哪个是本机这个账号，宁可不用。
   */
  #mirasimPick() {
    const pools = (this.report?.pools ?? [])
      .filter((p) => !p.problem && p.windows.some((w) => w.source === 'mirasim-relay'));
    if (pools.length === 1) return { pool: pools[0] };
    return {
      skipped: pools.length
        ? `fleet-dao 里有 ${pools.length} 个 Mirasim 池，认不出哪个是本机这个账号，不拿来替补`
        : 'fleet-dao 里没有读成过的 Mirasim 池',
    };
  }

  /**
   * 替补本机 Mirasim 的那份账号额度，形状与本机 /v1/limits 解析后一致（Engine 走同一条路算）。
   * 只收：上游这次报了的（没有 staleSince）、实读的、点数单位、数字齐全的窗口。
   * at 取这些窗口里最早的 readAt——龄期按最旧的那格算，不替它说新。
   * @returns { at, poolId, name, staleAfterSec, limits: { windows } } | null
   */
  mirasimSnapshot() {
    const { pool } = this.#mirasimPick();
    if (!pool) return null;
    const wins = pool.windows.filter((w) => w.staleSince == null && w.reading === 'measured' && w.unit === 'points'
      && finite(w.used) && finite(w.limit) && w.limit > 0 && w.resetsAt != null);
    if (!wins.length) return null;
    return {
      at: Math.min(...wins.map((w) => w.readAt)),
      poolId: pool.poolId, name: pool.name,
      staleAfterSec: this.report.staleAfterSec,
      limits: {
        windows: wins.map((w) => ({
          label: w.label, used: w.used, budget: w.limit, resetAt: w.resetsAt,
          ...(w.scope ? { modelScoped: true } : {}),
        })),
      },
    };
  }

  /** payload 的 fleet 块。没有令牌；未配置时只有 { state: 'off' }（面板据此给「接上」那张卡）。 */
  status() {
    if (!this.#config) return { state: 'off' };
    if (this.#config.broken) {
      return {
        state: 'error', ...(this.#config.url ? { url: this.#config.url } : {}),
        intervalSec: this.intervalSec, error: { code: 'config', message: this.#config.broken },
      };
    }
    const pick = this.report ? this.#mirasimPick() : null;
    return {
      state: this.lastError ? 'error' : this.report ? 'ok' : 'connecting',
      url: this.#config.url,
      intervalSec: this.intervalSec,
      ...(this.fetchedAt != null ? { fetchedAt: this.fetchedAt } : {}),
      ...(this.lastAttemptAt != null ? { lastAttemptAt: this.lastAttemptAt } : {}),
      ...(this.lastError ? { error: this.lastError, failStreak: this.failStreak } : {}),
      ...(this.report ? {
        asOf: this.report.asOf,
        staleAfterSec: this.report.staleAfterSec,
        pools: this.report.pools,
        mirasim: pick.pool ? { poolId: pick.pool.poolId, name: pick.pool.name } : { skipped: pick.skipped },
      } : {}),
    };
  }
}
