/**
 * fleet-dao 额度表：所有账号池 × 窗口的唯一来源，MiraQuota 是它的桌面窗口（2026-09-24）。
 *
 * 接口约定（全文与语义见 https://github.com/thoerwink8/miraquota-win/pull/3 正文，后端照它实现；
 * 后端落地后以 fleet-dao 仓 packages/shared 的 schema 为准，两边不一致就回来改这里）：
 *   GET <地址>/api/quota
 *   Authorization: Bearer <只读令牌>        ← 只能读额度，别的接口一律不认它
 *   200 → { schema: 1, asOf, staleAfterMinutes, pools: [...] }（逐字段见 parseQuotaReport）
 *   401 令牌不对/已吊销 · 403 令牌没有读额度的权限 · 404 这个地址上没有该接口 · 5xx 后端出错
 * 配置：~/.miraquota/fleet.json { url, token }，面板「账号池」页填，存本机、不进仓库。
 *
 * 改这里之前要知道的三条：
 *  1. **没读成就说没读成**：连不上、401、回包认不出，都是带 code 与人话的明确失败，不许用空列表
 *     冒充「查了没事」。上一份好数据留着（只进不退），但状态里写清它是多久以前的；
 *     「上游明说 0 个池 / 0 个窗口」与「没读成」是两回事，形状上就分得开。
 *  2. **时间一律换成本机钟**：按「本机收到时刻 − 服务端 asOf」校一次钟差，龄期与清零倒计时
 *     才不被两台机器的时钟差带偏。
 *  3. **令牌不出这个模块**：状态、payload、报错里都没有它；它只在 fleet.json 与请求头里。
 *     跳转一律不跟（redirect: manual）——跟过去就是把令牌带给另一台主机。
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

const UNITS = new Set(['percent', 'points', 'usd']);
const READINGS = new Set(['measured', 'estimated']);
const STATUSES = new Set(['allowed', 'warning', 'limit_reached']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const clip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isoSec = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms / 1000 : null;
};
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

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
 * 一个窗口 → 本机形状。认不出就返回 { problem }，调用方把它记进池的 problems，不静默丢。
 * @param skew 本机钟 − 服务端钟（秒），所有时刻都加上它
 */
function parseWindow(w, skew) {
  if (!isObj(w)) return { problem: '窗口不是对象' };
  const label = typeof w.label === 'string' ? w.label.trim() : '';
  if (!label) return { problem: '窗口缺 label' };
  const bad = (why) => ({ problem: `窗口 ${clip(label)}：${why}` });
  if (typeof w.window !== 'string' || !w.window) return bad('缺 window');
  if (!UNITS.has(w.unit)) return bad(`unit 只认 percent / points / usd，收到 ${clip(w.unit)}`);
  if (!READINGS.has(w.reading)) return bad(`reading 只认 measured / estimated，收到 ${clip(w.reading)}`);
  const readAt = isoSec(w.readAt);
  if (readAt == null) return bad('readAt 不是时间');
  if (typeof w.inLatestRead !== 'boolean') return bad('缺 inLatestRead');
  for (const k of ['utilization', 'used', 'limit']) {
    if (w[k] != null && !finite(w[k])) return bad(`${k} 不是数`);
  }
  let resetsAt = null;
  if (w.resetsAt != null) {
    resetsAt = isoSec(w.resetsAt);
    if (resetsAt == null) return bad('resetsAt 不是时间');
  }
  if (w.upstreamStatus != null && !STATUSES.has(w.upstreamStatus)) return bad(`upstreamStatus 认不出：${clip(w.upstreamStatus)}`);
  if (w.utilization == null && w.used == null && w.upstreamStatus == null) {
    return bad('既没有用量也没有上游状态，这一格什么都说明不了');
  }
  return {
    window: {
      label, window: w.window,
      ...(typeof w.scope === 'string' && w.scope ? { scope: w.scope } : {}),
      ...(w.utilization != null ? { utilization: w.utilization } : {}),
      ...(w.used != null ? { used: w.used } : {}),
      ...(w.limit != null ? { limit: w.limit } : {}),
      unit: w.unit,
      ...(resetsAt != null ? { resetsAt: resetsAt + skew } : {}),
      ...(w.upstreamStatus != null ? { upstreamStatus: w.upstreamStatus } : {}),
      ...(typeof w.statusRaw === 'string' && w.statusRaw ? { statusRaw: clip(w.statusRaw) } : {}),
      reading: w.reading,
      source: typeof w.source === 'string' ? w.source : '',
      readAt: readAt + skew,
      inLatestRead: w.inLatestRead,
    },
  };
}

/** 一个池 → 本机形状。池本身认不出时保留一行 { poolId?, name, problem }，界面照样给它一格。 */
function parsePool(p, skew, index) {
  if (!isObj(p)) return { poolId: `#${index + 1}`, name: `第 ${index + 1} 个池`, problem: '池不是对象', windows: [], notes: [], problems: [] };
  const poolId = typeof p.poolId === 'string' && p.poolId ? p.poolId : null;
  const name = typeof p.name === 'string' && p.name.trim() ? clip(p.name) : (poolId ?? `第 ${index + 1} 个池`);
  const shell = { poolId: poolId ?? `#${index + 1}`, name, windows: [], notes: [], problems: [] };
  if (!poolId) return { ...shell, problem: '池缺 poolId' };
  if (!Array.isArray(p.windows)) return { ...shell, problem: 'windows 不是数组' };

  let lastAttempt = null;
  if (p.lastAttempt != null) {
    const at = isoSec(p.lastAttempt?.at);
    if (!isObj(p.lastAttempt) || at == null || typeof p.lastAttempt.ok !== 'boolean') {
      return { ...shell, problem: 'lastAttempt 认不出（要 { at, ok, error? }）' };
    }
    const e = p.lastAttempt.error;
    lastAttempt = {
      at: at + skew, ok: p.lastAttempt.ok,
      ...(!p.lastAttempt.ok ? { error: { code: clip(e?.code) || 'unknown', message: clip(e?.message) || '后端没说原因' } } : {}),
    };
  }
  let lastSuccessAt = null;
  if (p.lastSuccessAt != null) {
    lastSuccessAt = isoSec(p.lastSuccessAt);
    if (lastSuccessAt == null) return { ...shell, problem: 'lastSuccessAt 不是时间' };
    lastSuccessAt += skew;
  }

  const windows = [];
  const problems = [];
  const seen = new Set();
  for (const raw of p.windows) {
    const r = parseWindow(raw, skew);
    if (r.problem) { problems.push(r.problem); continue; }
    if (seen.has(r.window.label)) { problems.push(`窗口 ${clip(r.window.label)} 出现了两次，只留第一条`); continue; }
    seen.add(r.window.label);
    windows.push(r.window);
  }
  const sub = isObj(p.subscription) ? p.subscription : null;
  const expiresAt = sub ? isoSec(sub.expiresAt) : null;
  return {
    poolId, name,
    channelId: typeof p.channelId === 'string' ? p.channelId : '',
    reader: typeof p.reader === 'string' ? p.reader : '',
    lastAttempt, lastSuccessAt,
    ...(sub && (sub.plan || expiresAt != null) ? {
      subscription: { ...(sub.plan ? { plan: clip(sub.plan) } : {}), ...(expiresAt != null ? { expiresAt: expiresAt + skew } : {}) },
    } : {}),
    notes: Array.isArray(p.notes) ? p.notes.filter((n) => typeof n === 'string' && n).map(clip) : [],
    problems,
    windows,
  };
}

/**
 * GET /api/quota 的回包 → 本机形状。顶层认不出（不是对象、版本不对、缺 asOf / pools）整份拒收；
 * 单个池或窗口认不出只影响它自己，并记进 problem / problems 给界面说出来。
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
  return {
    ok: true,
    report: {
      schema: body.schema,
      asOf: receivedAt,
      skewSec: skew,
      staleAfterSec: body.staleAfterMinutes * 60,
      pools: body.pools.map((p, i) => parsePool(p, skew, i)),
    },
  };
}

/** 一次 HTTP 读取的失败 → { code, message }。人话在前，原文截断附后。 */
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
 * @param fetchImpl 测试注入
 */
export async function fetchQuota(base, token, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, now = () => Date.now() / 1000 } = {}) {
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
    return { ok: false, error: { code: 'unreachable', message: `连不上 fleet-dao${why ? '：' + why : ''}` } };
  }
  if (!r.ok) return { ok: false, error: await httpFailure(r) };
  let body;
  try { body = await r.json(); } catch { return { ok: false, error: { code: 'bad_response', message: '回包不是 JSON' } }; }
  const parsed = parseQuotaReport(body, now());
  if (!parsed.ok) return { ok: false, error: { code: 'bad_response', message: `回包不符合约定：${parsed.error}` } };
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

  /** fleet.json 读不出或不完整 ⇒ 当未配置（不抛：设置读不出来不该拖垮取数主流程）。 */
  #readConfig() {
    try {
      const c = JSON.parse(readFileSync(this.configFile, 'utf8'));
      const u = normalizeBaseUrl(c?.url);
      const token = typeof c?.token === 'string' ? c.token.trim() : '';
      return u.ok && token ? { url: u.url, token } : null;
    } catch { return null; }
  }

  get enabled() { return !!this.#config; }
  get url() { return this.#config?.url ?? null; }

  /** 真读一次；同一时刻只有一个在路上（重复调用拿到同一个 Promise）。未配置返回 null。 */
  refresh() {
    if (!this.#config) return Promise.resolve(null);
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
    if (!this.#config || this.#inflight) return;
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
    if (!t) return { ok: false, code: 'config', error: '令牌是空的' };
    if (/\s/.test(t)) return { ok: false, code: 'config', error: '令牌里有空白字符，多半是粘多了' };
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
   * 哪个池替补本机 Mirasim：reader 是 mirasim-relay 的池**恰好一个**才用。
   * 额度点是账号级的，同一个账号谁读到都一样；有两个就认不出哪个是本机这个账号，宁可不用。
   */
  #mirasimPick() {
    const pools = (this.report?.pools ?? []).filter((p) => p.reader === 'mirasim-relay' && !p.problem);
    if (pools.length === 1) return { pool: pools[0] };
    return {
      skipped: pools.length
        ? `fleet-dao 里有 ${pools.length} 个 Mirasim 池，认不出哪个是本机这个账号，不拿来替补`
        : 'fleet-dao 里没有 Mirasim 池',
    };
  }

  /**
   * 替补本机 Mirasim 的那份账号额度，形状与本机 /v1/limits 解析后一致（Engine 走同一条路算）。
   * 只收：这一轮上游报了的（inLatestRead）、实读的、点数单位、数字齐全的窗口。
   * at 取这些窗口里最早的 readAt——龄期按最旧的那格算，不替它说新。
   * @returns { at, poolId, name, staleAfterSec, limits: { windows } } | null
   */
  mirasimSnapshot() {
    const { pool } = this.#mirasimPick();
    if (!pool) return null;
    const wins = pool.windows.filter((w) => w.inLatestRead && w.reading === 'measured' && w.unit === 'points'
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
