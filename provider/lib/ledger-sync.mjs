/**
 * 多机账本同步：每台机器把本机账本聚合态（分钟桶）作为分片，与其他机器互读。
 * 点数是账号级、账本是本机级，多台机器共用额度时「本机$ ÷ 账号点」系统性偏低——
 * 合并全机分片后，标定/归因/强度的分子才与账号级点数同口径（见 docs/MULTI-MACHINE.md）。
 *
 * 只剩一条通道：收件口 { inbox, account, passphrase }（2026-09-02 用户拍板）。客户端零仓库凭据，
 * 只带自报名字 + 自设口令，HTTP 推给 Cloudflare Worker，分片存它的 KV（见 inbox/worker.mjs）。
 * 文件不存在、或没有可用的收件口配置 ⇒ 功能完全关闭，零副作用。
 *
 * **分片只搬账本、速度与流水，不搬账号额度。** 账号额度只认两个来源：本机 /v1/limits 实读，
 * 与 fleet-dao 的额度表（见 fleet-source.mjs）。分片里捎带额度（v0.9.28）与 hub 通道一起下线。
 *
 * 退役的通道不静默失联：配着它的老 sync.json 当未配置处理，日志说清怎么换，界面也说一句
 * （`retiredChannel`）：
 *  - git 通道（{ remote }）2026-09-23 退役：用户「不要存 Github，占项目大小和烧 cpu」——实测每台
 *    机器每 10 分钟要提交 333 KB（≈47 MB/天）；
 *  - hub 通道（{ hub, token }）2026-09-24 下线：多机额度改由 fleet-dao 统一读，自建服务器那条
 *    路的客户端代码删掉（服务端 server/ 留到停服那一步一起删）。
 *
 * 故障呈现取舍（2026-09-01 实测：本地代理偶发 SSL_ERROR_SYSCALL，紧接着的六次访问全成功）：
 * 抖动不该报红——红色只留给用户真要处置的持续故障。三道闸依次拦：
 *  ① 单轮内短退避重试一次；② 发布成功而只读取失败算中间态（本机数据已上传，合并样本少一点而已）；
 *  ③ 仍失败要连续 ERROR_STREAK 轮、或上次成功已过期，才进 error。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';

const CONFIG_FILE = join(homedir(), '.miraquota', 'sync.json');
const INSTALL_FILE = join(homedir(), '.miraquota', 'install.json');
const INBOX_CACHE = join(homedir(), '.miraquota', 'inbox-shards.json');
const DEFAULT_INTERVAL = 600;   // 秒；sync.json 未写 intervalSec 时的节流间隔
const RETRY_DELAY_MS = 2000;    // 单轮内退避重试的等待
const ERROR_STREAK = 2;         // 连续失败达到这个轮数才进 error（红），此前是重试中（黄）
const HTTP_TIMEOUT_MS = 30_000;
export const SHARD_SCHEMA = 1;

/**
 * 默认收件口。部署 inbox/ 后把 workers.dev 地址填到这里；多机页的登录框预填它、允许改。
 * 地址本身不是秘密（Worker 只认名字+口令+邀请码），放在公开代码里没关系。
 */
export const DEFAULT_INBOX = 'https://miraquota-inbox.miraquota.workers.dev';
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * 单轮内退避重试一次：网络抖动不该被记成一次失败。
 * 代价：HTTP 请求自带 30s 超时，重试后单步最坏 ~62s，仍远小于同步间隔（默认 600s），
 * 且 run() 在 engine 里是后台异步任务，不阻断轮询主流程。
 */
export async function retryOnce(fn, delayMs = RETRY_DELAY_MS) {
  try { return await fn(); } catch {
    await new Promise((r) => setTimeout(r, delayMs));
    return await fn();      // 仍失败就把这次（最新）的原因抛给调用方计数
  }
}

/**
 * 常见报错的人话归纳。原始报错另存 sync.error 当次要小字，人话丢原文更难查。
 * 顺序有讲究：权限类报错常同时含 'unable to access'，必须先判权限再判网络。
 */
const ERROR_HINTS = [
  [/名字或口令不对|401/i, '名字或口令不对（在多机页重新登录）'],
  [/authentication|could not read username|invalid credentials|403|permission|denied/i, '凭据无效或无权限'],
  [/repository not found|not found|no such endpoint|404/i, '仓库/收件口地址不对或已不存在'],
  // 网络类要把 Node 的 errno 码也算进来：真机上见过 fetch failed（fetch 的包装），
  // 也见过裸的 ECONNREFUSED/ENOTFOUND/EAI_AGAIN（写进 sync.error 的就是它们）。
  [/ssl|unable to access|could not resolve host|resolve|timed out|timeout|connection (?:reset|refused|closed)|network is unreachable|proxy|failed to connect|fetch failed|aborted|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i,
    '网络连不上（代理或网络问题）'],
];

/** 归纳不出来时返回 null——UI 此时直接把原文当主文案，不硬套。 */
export function explainSyncError(raw) {
  const s = String(raw ?? '');
  for (const [re, hint] of ERROR_HINTS) if (re.test(s)) return hint;
  return null;
}

/** os.hostname() 清洗成可作分支名的短名：小写、只留字母数字与连字符。 */
export function cleanMachineId(name = hostname()) {
  const id = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
  return id || 'machine';
}

/**
 * 本机安装 id：首次运行生成 16 位十六进制随机数，落盘后不变。
 * 机器靠它区分（同名主机不撞），重装即视为新机器。文件坏了就重生成——它不承载任何账目。
 */
export function readInstallId(file = INSTALL_FILE) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))?.installId;
    if (typeof v === 'string' && /^[a-f0-9]{8,32}$/.test(v)) return v;
  } catch { /* 首次 */ }
  const id = randomBytes(8).toString('hex');
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ installId: id }) + '\n'); } catch { /* 落不了盘就用内存值 */ }
  return id;
}

/** 收件口 HTTP：非 2xx 一律抛，错误体里的 error 字段就是人话原因。 */
async function http(url, { method = 'GET', headers = {}, body = null, timeout = HTTP_TIMEOUT_MS } = {}) {
  const r = await fetch(url, {
    method, body,
    headers: { 'user-agent': 'miraquota', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (r.ok) return r.status === 204 ? null : r.json();
  let why = '';
  try { why = (await r.json())?.error ?? ''; } catch { /* 非 JSON */ }
  const e = new Error(`${why || 'HTTP ' + r.status} (${r.status})`);
  e.status = r.status;
  throw e;
}

/** 退役通道的日志：说清它不会启动、以及该换到哪。 */
const RETIRED_HINT = {
  git: (c) => '[sync] sync.json 配的是已退役的 git 通道（remote='
    + `${String(c.remote).trim()}）——同步不会启动。要合并多机账本，在多机页用收件口登录。`,
  hub: () => '[sync] sync.json 配的是已下线的 hub 通道（自建服务器）——同步不会启动。'
    + '账号额度改由 fleet-dao 统一读（面板「账号池」页填地址和只读令牌）；'
    + '要继续合并多机账本，在多机页用收件口登录。',
};

export class LedgerSync {
  /**
   * @param opts.configFile 配置文件路径（测试注入用，默认 ~/.miraquota/sync.json）
   * @param opts.machineId  机器短名（默认 os.hostname() 清洗）
   * @param opts.installId  安装 id（默认读/生成 ~/.miraquota/install.json）
   * @param opts.cacheFile  收件口分片缓存（默认 ~/.miraquota/inbox-shards.json）
   * @param opts.retryDelayMs 单轮内重试的等待（测试注入用，默认 2 秒）
   */
  constructor({ configFile = CONFIG_FILE, machineId = cleanMachineId(),
    installId = null, installFile = INSTALL_FILE, cacheFile = INBOX_CACHE,
    retryDelayMs = RETRY_DELAY_MS } = {}) {
    this.configFile = configFile;
    this.machineId = machineId;
    this.installId = installId ?? readInstallId(installFile);
    this.cacheFile = cacheFile;
    this.retryDelayMs = retryDelayMs;
    this.shards = [];          // 最近一次读到的外机分片（内存缓存）
    this.lastSyncSec = null;   // 最近一次成功同步的时刻（发布＋读取都成）
    this.lastPublishSec = null; // 本机分片最近一次成功发布的时刻
    this.lastError = null;
    this.pushOk = false;       // 最近一轮本机分片是否发布成功（区分「只是读不到他机」）
    this.failStreak = 0;       // 连续失败轮数：抖动一次不报红，达 ERROR_STREAK 才报
    this.retiredChannel = null; // sync.json 配的是已退役的通道（'git' | 'hub'）时记下，界面据此说一句
    this.config = this.#loadConfig();
  }

  /** 文件不存在、解析失败、没有可用的收件口配置 ⇒ 功能关闭（硬性验收：现行为零变化）。 */
  #loadConfig() {
    this.retiredChannel = null;
    let c;
    try { c = JSON.parse(readFileSync(this.configFile, 'utf8')); } catch { return null; }
    const interval = Number(c?.intervalSec);
    const intervalSec = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL;
    if (typeof c?.inbox === 'string' && c.inbox.trim() && ACCOUNT_RE.test(c.account ?? '')
      && typeof c.passphrase === 'string' && c.passphrase.length >= 4) {
      return { mode: 'inbox', inbox: c.inbox.trim().replace(/\/+$/, ''), account: c.account, passphrase: c.passphrase, intervalSec };
    }
    const retired = typeof c?.hub === 'string' && c.hub.trim() ? 'hub'
      : typeof c?.remote === 'string' && c.remote.trim() ? 'git' : null;
    if (retired) {
      this.retiredChannel = retired;
      console.warn(RETIRED_HINT[retired](c));
    }
    return null;
  }

  get enabled() { return !!this.config; }
  get mode() { return this.config?.mode ?? null; }
  get intervalSec() { return this.config?.intervalSec ?? DEFAULT_INTERVAL; }
  /**
   * 推流水的去处（通道 + 地址 + 名字）。流水水位按它分开记：换了去处就从保留窗起点重推，
   * 不沿用别处的进度（见 JournalLedger.journalWatermark）。没配同步时是 null。
   */
  get destination() {
    return this.config?.mode === 'inbox' ? `inbox|${this.config.inbox}|${this.config.account}` : null;
  }
  /** 分片上的身份：收件口模式带 account，都带 installId。 */
  get identity() {
    return { installId: this.installId, ...(this.config?.mode === 'inbox' ? { account: this.config.account } : {}) };
  }

  /**
   * 收件口登录（多机页的登录框）：名字 + 自设口令；名字还没人用时再要邀请码去注册。
   * 顺序有讲究：先试 /login——名字是他自己的（另一台机器登过），不该再问邀请码。
   * 成功即写 sync.json 切到收件口模式；失败返回人话原因，不改任何文件。
   * @returns { ok: true, registered: boolean } | { ok: false, error }
   */
  async login({ inbox = DEFAULT_INBOX, account, passphrase, invite = '' } = {}) {
    const base = String(inbox ?? '').trim().replace(/\/+$/, '');
    account = String(account ?? '').trim().toLowerCase();
    if (!/^https?:\/\//.test(base)) return { ok: false, error: '收件口地址要以 http(s):// 开头' };
    if (!ACCOUNT_RE.test(account)) return { ok: false, error: '名字只能是小写字母、数字、连字符，1–24 位' };
    if (typeof passphrase !== 'string' || passphrase.length < 4) return { ok: false, error: '口令至少 4 位' };
    let registered = false;
    try {
      await http(`${base}/login`, { method: 'POST', body: JSON.stringify({ account, passphrase }) });
    } catch (e) {
      if (e.status !== 401) return { ok: false, error: explainSyncError(e.message) ?? e.message };
      if (!invite) return { ok: false, error: '这个名字还没注册，需要邀请码', needInvite: true };
      try {
        await http(`${base}/register`, { method: 'POST', body: JSON.stringify({ account, passphrase, invite }) });
        registered = true;
      } catch (e2) {
        // 409：名字已被别人占且口令不是它的——不是「再输一次邀请码」能解决的，说清楚
        if (e2.status === 409) return { ok: false, error: '这个名字已经有人用了，而口令不是它的——换个名字' };
        return { ok: false, error: e2.message.replace(/ \(\d+\)$/, '') };
      }
    }
    try {
      mkdirSync(dirname(this.configFile), { recursive: true });
      writeFileSync(this.configFile, JSON.stringify({ inbox: base, account, passphrase, intervalSec: DEFAULT_INTERVAL }, null, 2) + '\n');
    } catch (e) { return { ok: false, error: `配置写不进去：${e.message}` }; }
    this.config = this.#loadConfig();
    this.lastError = null; this.failStreak = 0;
    return { ok: true, registered };
  }

  /**
   * 把本机**流水增量**推给收件口（明细，供账号级对账与任务报表）。
   *
   * 与分片分开：分片是聚合（三张卡够用），流水是明细——读的一方拿到明细才出得了「每个任务花了
   * 多少」。行格式与 `inbox/shared.mjs` 的 `validateJournal` 是同一套判据。
   * @returns {number} 推上去的行数；没配时 0，调用方据此决定要不要退水位
   */
  async pushJournal(rows) {
    if (!Array.isArray(rows) || !rows.length) return 0;
    if (this.config?.mode !== 'inbox') return 0;
    await http(`${this.config.inbox}/journal`, {
      method: 'PUT', headers: this.#inboxAuth(),
      body: JSON.stringify({ installId: this.installId, rows }),
    });
    return rows.length;
  }

  #inboxAuth() {
    return { 'x-account': this.config.account, 'x-passphrase': this.config.passphrase };
  }

  /**
   * 收件口：取回**本账号**各机的流水明细（要口令；Worker 只回同一个账号的——明细里有会话 id
   * 与工作区路径，不能像聚合分片那样跨账号可读）。
   *
   * 剔掉自己那份：本机流水本来就在自己的库里。失败一律回空——它不该让分片同步跟着变红。
   */
  async #fetchJournals() {
    try {
      const all = await http(`${this.config.inbox}/journals`, { headers: this.#inboxAuth() });
      return (Array.isArray(all) ? all : [])
        .filter((j) => j && j.installId !== this.installId && Array.isArray(j.rows) && j.rows.length);
    } catch { return []; }
  }

  /** 收件口：发布就是一次 PUT；分片里带 account/installId，Worker 据此定分支名。 */
  async #publishInbox(shard) {
    await http(`${this.config.inbox}/shard`, {
      method: 'PUT', body: JSON.stringify(shard), headers: this.#inboxAuth(),
    });
  }

  /** 收件口：一次 GET 拿全部分片，剔掉自己，顺手落缓存供冷启动。 */
  async #fetchInbox() {
    const all = await http(`${this.config.inbox}/shards`);
    const shards = (Array.isArray(all) ? all : []).filter((s) => this.#isForeign(s));
    try { writeFileSync(this.cacheFile, JSON.stringify(shards)); } catch { /* 缓存写不进去不影响本轮 */ }
    return shards;
  }

  /**
   * 「是不是我自己」要 installId 和 machineId 都对上才算：installId 一样而主机名不同，
   * 是整个 ~/.miraquota 被拷到了另一台机器（或测试里两台共用一个 HOME）——那是两台机器。
   * 老分片没有 installId，退回只比主机名。
   */
  #isForeign(s) {
    if (!s || !s.machineId) return false;
    if (s.installId && s.installId !== this.installId) return true;
    return s.machineId !== this.machineId;
  }

  /**
   * 冷启动即用上一轮已读到的分片：只读本地，不联网、不改工作区。
   *
   * 不做的话，进程从启动到第一轮同步跑完（最长 intervalSec）都只认本机账本——美元、
   * 标定单价、多机页机器数全部按单机口径给，用户看到的是「他机明明推过了，我这没有」。
   * 分片带 generatedAt，过期与否由显示面判定，读旧的不会让口径回退（比缺整台机器好）。
   */
  async loadCachedShards() {
    if (!this.enabled) return [];
    let shards = [];
    try { shards = JSON.parse(readFileSync(this.cacheFile, 'utf8')).filter((s) => this.#isForeign(s)); } catch { return []; }
    if (shards.length) this.shards = shards;
    return shards;
  }

  /**
   * 一轮同步：发布本机分片 + 读回全部外机分片，两条链分开记（发布成功只读取失败是中间态）。
   * 任何失败都不抛，只记入 lastError；上一轮读到的分片保留（远端临时不可达时合并口径不回退）。
   * 返回 status() 的全部字段外加 shards 与 journals，功能关闭时返回 null。
   * @param extras 附加到本机分片上的非账本块（当前只有 speed）；合并口径一个字节都不读它
   */
  async run(ledger, nowSec = Date.now() / 1000, extras = null) {
    if (!this.enabled) return null;
    const firstLine = (e) => String(e.message || e).split('\n')[0].slice(0, 200);
    let err = null;
    try {
      // extras 只供「看那台机器」的视角切换用，不参与合并：分片格式没变（schemaVersion 仍是 1），
      // 老版本读到多出来的字段直接忽略，两代客户端可以混跑。
      const shard = { ...ledger.exportShard(this.machineId, nowSec, this.identity), ...(extras ?? {}) };
      await retryOnce(() => this.#publishInbox(shard), this.retryDelayMs);
      this.lastPublishSec = nowSec;   // 发布已成功，即使随后读取失败也算数
      this.pushOk = true;
    } catch (e) { this.pushOk = false; err = firstLine(e); }
    // 发布都推不上去时同一端点的读取几无成功可能，省一次网络往返直接跳过。
    let journals = [];
    if (this.pushOk) {
      try {
        this.shards = await retryOnce(() => this.#fetchInbox(), this.retryDelayMs);
        this.lastSyncSec = nowSec;
        // 顺带取回他机的流水明细：**读的一方负责落库**（KV 只是中转，没有能查询的存储），
        // 所以这里只取回来，由调用方（Engine）写进自己的库。
        journals = await this.#fetchJournals();
      } catch (e) { err = firstLine(e); }
    }
    this.lastError = err;
    this.failStreak = err ? this.failStreak + 1 : 0;
    return { ...this.status(nowSec), shards: this.shards, journals };
  }

  /**
   * payload 的 sync 字段。四态对四色，红只留给要用户处置的持续故障：
   *  - 'ok'（绿）最近一轮发布＋读取都成，且不超过 2×intervalSec；
   *  - 'warn'（黄）有失败但还不到报红：pushOk 时是「本机已上传、读不到他机」，
   *    否则是抖动重试中（连续失败未达 ERROR_STREAK 且上次成功还没过期）；
   *  - 'error'（红）连续失败达 ERROR_STREAK 轮，或曾经成功过但已过期还在失败；
   *  - 'connecting'（灰）启用但从未成功，或成功记录已过期且当轮没有失败原因。
   * 另带 pushOk / failStreak 供 UI 挑文案，error 是原始首行、errorHint 是人话（归纳得出才有）。
   *  - machines：每台机器一行 { id, key, account, lastShardSec, self }——id 是主机短名（显示用），
   *    key 是 installId（没有就退回 id，老分片），account 是自报名字。
   */
  status(nowSec = Date.now() / 1000) {
    const fresh = this.lastSyncSec != null && nowSec - this.lastSyncSec <= 2 * this.intervalSec;
    let state;
    if (!this.lastError) state = fresh ? 'ok' : 'connecting';
    else if (this.pushOk) state = 'warn';   // 本机分片已上传：合并样本少一点，不会算错
    else state = (this.failStreak >= ERROR_STREAK || (this.lastSyncSec != null && !fresh))
      ? 'error' : 'warn';
    const hint = this.lastError ? explainSyncError(this.lastError) : null;
    return {
      state,
      mode: this.mode,
      pushOk: this.pushOk,
      intervalSec: this.intervalSec,   // 显示面据此判「分片超过 2×interval 未更新 ⇒ 已过期」
      ...(this.mode === 'inbox' ? { inbox: this.config.inbox, account: this.config.account } : {}),
      machines: [
        { id: this.machineId, key: this.installId, account: this.config?.account ?? null, lastShardSec: this.lastPublishSec, self: true },
        ...this.shards.map((s) => ({
          id: s.machineId, key: s.installId ?? s.machineId, account: s.account ?? null,
          lastShardSec: s.generatedAt, self: false,
          // 那台机器自己的速度快照（v0.9.27 起随分片带上，最多落后一轮）。轻客户端与老版本
          // 没有这块，字段就省略——界面据此决定给不给它「看这台」的入口。
          ...(s.speed?.rows?.length ? { speed: s.speed } : {}),
        })),
      ],
      ...(this.lastSyncSec != null ? { lastSyncSec: this.lastSyncSec } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(hint ? { errorHint: hint } : {}),
      ...(this.failStreak > 0 ? { failStreak: this.failStreak } : {}),
    };
  }
}
