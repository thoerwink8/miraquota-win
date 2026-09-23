/**
 * 多机账本同步：每台机器把本机账本聚合态（分钟桶）作为分片，与其他机器互读。
 * 点数是账号级、账本是本机级，多台机器共用额度时「本机$ ÷ 账号点」系统性偏低——
 * 合并全机分片后，标定/归因/强度的分子才与账号级点数同口径（见 docs/MULTI-MACHINE.md）。
 *
 * 两种通道，配置文件 ~/.miraquota/sync.json 决定走哪条：
 *  - hub 通道 { hub, token }（自建服务器，**推荐**）：POST 分片、GET 全部分片，另外 PUT 流水明细
 *    （`/journal`，见 pushJournal）。一台机器一份，服务端按 installId 整份覆盖。
 *  - 收件口通道 { inbox, account, passphrase }（2026-09-02 用户拍板）：没有自建服务器的人走这里。
 *    客户端零仓库凭据，只带自报名字 + 自设口令，HTTP 推给 Cloudflare Worker，分片存它的 KV
 *    （见 inbox/worker.mjs），Worker 也不需要 GitHub 令牌。
 *  - 文件不存在、或既无 hub 也无 inbox ⇒ 功能完全关闭，零副作用。
 *
 * git 通道（{ remote }，把分片提交进一个私有 GitHub 仓）2026-09-23 退役并**删掉了**：用户
 * 「不要存 Github，占项目大小和烧 cpu」——实测每台机器每 10 分钟要提交 333 KB（≈47 MB/天）。
 * 配着它的老 sync.json 当未配置处理，并在日志里说清怎么换（不静默失联）。
 *
 * 故障呈现取舍（2026-09-01 实测：本地代理偶发 SSL_ERROR_SYSCALL，紧接着的六次访问全成功）：
 * 抖动不该报红——红色只留给用户真要处置的持续故障。三道闸依次拦：
 *  ① 单轮内短退避重试一次；② 发布成功而只读取失败算中间态（本机数据已上传，合并样本少一点而已）；
 *  ③ 仍失败要连续 ERROR_STREAK 轮、或上次成功已过期，才进 error。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';

const CONFIG_FILE = join(homedir(), '.miraquota', 'sync.json');
const INSTALL_FILE = join(homedir(), '.miraquota', 'install.json');
const INBOX_CACHE = join(homedir(), '.miraquota', 'inbox-shards.json');
const DEFAULT_INTERVAL = 600;   // 秒；sync.json 未写 intervalSec 时的节流间隔
/**
 * 「有账号额度在手/急着要账号额度」那几轮的快节奏（秒）。账本迟到十分钟无所谓——
 * 它是流水，补上就行；账号额度不一样，本机 Mirasim 没在跑时它是**唯一**的额度来源，
 * 十分钟前的数字直接印在卡片主行上。sync.json 写 quotaIntervalSec 可覆盖（想关掉就填成
 * 和 intervalSec 一样大）。
 */
const DEFAULT_QUOTA_INTERVAL = 120;
const RETRY_DELAY_MS = 2000;    // 单轮内退避重试的等待
const ERROR_STREAK = 2;         // 连续失败达到这个轮数才进 error（红），此前是重试中（黄）
const HTTP_TIMEOUT_MS = 30_000;
export const SHARD_SCHEMA = 1;

/**
 * 默认收件口。部署 inbox/ 后把 workers.dev 地址填到这里；多机页的登录框预填它、允许改。
 * 地址本身不是秘密（Worker 只认名字+口令+邀请码），放在公开代码里没关系。
 */
export const DEFAULT_INBOX = 'https://miraquota-inbox.miraquota.workers.dev';
/**
 * 默认自建服务器（hub）。2026-09-05 部署，见 server/README.md。
 * 地址不是秘密（写接口要 token，token 只在那台机器的 config.json 里），
 * 预填它是为了新机器只用粘一个 token，不用记地址。
 */
export const DEFAULT_HUB = 'https://156.224.28.95.sslip.io/mq';
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

export class LedgerSync {
  /**
   * @param opts.configFile 配置文件路径（测试注入用，默认 ~/.miraquota/sync.json）
   * @param opts.machineId  机器短名（默认 os.hostname() 清洗）
   * @param opts.installId  安装 id（默认读/生成 ~/.miraquota/install.json）
   * @param opts.cacheFile  收件口分片缓存（默认 ~/.miraquota/inbox-shards.json）
   * @param opts.inboxUrl   收件口地址（默认 DEFAULT_INBOX；传 null 关掉）
   * @param opts.retryDelayMs 单轮内重试的等待（测试注入用，默认 2 秒）
   */
  constructor({ configFile = CONFIG_FILE, machineId = cleanMachineId(),
    installId = null, installFile = INSTALL_FILE, cacheFile = INBOX_CACHE, inboxUrl = DEFAULT_INBOX,
    retryDelayMs = RETRY_DELAY_MS } = {}) {
    this.inboxUrl = inboxUrl;
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
    this.config = this.#loadConfig();
  }

  /** 文件不存在、解析失败、既无 hub 也无 inbox ⇒ 功能关闭（硬性验收：现行为零变化）。 */
  #loadConfig() {
    try {
      const c = JSON.parse(readFileSync(this.configFile, 'utf8'));
      const interval = Number(c?.intervalSec);
      const intervalSec = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL;
      const quota = Number(c?.quotaIntervalSec);
      // 快节奏不该反过来比常规轮还慢，min() 兜住配错的情况
      const quotaIntervalSec = Number.isFinite(quota) && quota > 0
        ? Math.min(quota, intervalSec) : Math.min(DEFAULT_QUOTA_INTERVAL, intervalSec);
      // hub 通道优先：自建服务器是「唯一真相」，配了它就不该再走收件口那条
      // 「没有服务器时的替代品」（用户 2026-09-05 拍板）。
      if (typeof c?.hub === 'string' && c.hub.trim()) {
        return {
          mode: 'hub', hub: c.hub.trim().replace(/\/+$/, ''), token: c.token ?? null,
          intervalSec, quotaIntervalSec,
        };
      }
      if (typeof c?.inbox === 'string' && c.inbox.trim() && ACCOUNT_RE.test(c.account ?? '')
        && typeof c.passphrase === 'string' && c.passphrase.length >= 4) {
        return { mode: 'inbox', inbox: c.inbox.trim().replace(/\/+$/, ''), account: c.account, passphrase: c.passphrase, intervalSec, quotaIntervalSec };
      }
      // git 通道 2026-09-23 退役（用户：「不要存 Github，占项目大小和烧 cpu」——实测每台机器
      // 每 10 分钟要提交 333 KB）。配着它的机器不静默失联：说清楚该怎么换，然后当未配置。
      if (typeof c?.remote === 'string' && c.remote.trim()) {
        console.warn('[sync] sync.json 配的是已退役的 git 通道（remote='
          + `${c.remote.trim()}）——同步不会启动。改用自建服务器或收件口：`
          + 'node scripts/deploy-linux.mjs --host <机器> --hub <地址> --token <令牌>');
      }
      return null;
    } catch { return null; }
  }

  get enabled() { return !!this.config; }
  get mode() { return this.config?.mode ?? null; }
  get intervalSec() { return this.config?.intervalSec ?? DEFAULT_INTERVAL; }
  /** 带着账号额度那几轮的间隔（见 DEFAULT_QUOTA_INTERVAL）。 */
  get quotaIntervalSec() { return this.config?.quotaIntervalSec ?? Math.min(DEFAULT_QUOTA_INTERVAL, this.intervalSec); }
  /** 分片上的身份：收件口模式带 account，两种模式都带 installId。 */
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
   * 接上自建服务器（多机页那张卡）：地址 + token，先探一次 /health 再写配置。
   * 探通才写——写完才发现地址错了，用户看到的是「同步失败」而不是「地址填错了」。
   * 成功即切到 hub 模式，git 仓与收件口那两条通道自动让位。
   * @returns { ok: true } | { ok: false, error }
   */
  async connectHub({ hub = DEFAULT_HUB, token = '' } = {}) {
    const base = String(hub ?? '').trim().replace(/\/+$/, '');
    token = String(token ?? '').trim();
    if (!/^https?:\/\//.test(base)) return { ok: false, error: '服务器地址要以 http(s):// 开头' };
    try {
      const h = await http(`${base}/health`, { timeout: 15_000 });
      if (h?.name !== 'miraquota-hub') return { ok: false, error: '这个地址不是 MiraQuota 服务器' };
    } catch (e) {
      return { ok: false, error: explainSyncError(e.message) ?? e.message };
    }
    // token 对不对要用写接口验：/health 是不鉴权的，探通了不代表推得上去
    try {
      await http(`${base}/shard`, {
        method: 'PUT',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify({
          schemaVersion: SHARD_SCHEMA, machineId: this.machineId, installId: this.installId,
          generatedAt: Date.now() / 1000, coverage: { fromSec: 0, toSec: 0 },
          buckets: {}, scoped: {}, family: {}, unpriced: {},
        }),
      });
    } catch (e) {
      if (e.status === 401) return { ok: false, error: 'token 不对（去服务器的 config.json 里看）' };
      return { ok: false, error: explainSyncError(e.message) ?? e.message };
    }
    try {
      mkdirSync(dirname(this.configFile), { recursive: true });
      writeFileSync(this.configFile, JSON.stringify({ hub: base, token, intervalSec: DEFAULT_INTERVAL }, null, 2) + '\n');
    } catch (e) { return { ok: false, error: `配置写不进去：${e.message}` }; }
    this.config = this.#loadConfig();
    this.lastError = null; this.failStreak = 0;
    return { ok: true };
  }

  /**
   * 收件口通道的机器也看得见别人：分片存在 Worker 的 KV 里。
   * 这是附加来源——读不到只是少几台机器，不记 error、不改状态色。
   */
  async #readInboxQuietly() {
    if (!this.inboxUrl || /REPLACE-ME/.test(this.inboxUrl)) return [];
    try {
      const all = await http(`${this.inboxUrl}/shards`, { timeout: 10_000 });
      const shards = (Array.isArray(all) ? all : []).filter((s) => this.#isForeign(s));
      try { writeFileSync(this.cacheFile, JSON.stringify(shards)); } catch { /* 缓存可有可无 */ }
      return shards;
    } catch { return []; }
  }

  /** 同一台机器（installId，老分片退回主机名）只留 generatedAt 最新的一份。 */
  #mergeShards(...lists) {
    const byKey = new Map();
    for (const s of lists.flat()) {
      const k = s.installId ?? s.machineId;
      if (!byKey.has(k) || (s.generatedAt ?? 0) > (byKey.get(k).generatedAt ?? 0)) byKey.set(k, s);
    }
    return [...byKey.values()];
  }

  /** hub：一次 PUT，服务端按 installId 整份覆盖。鉴权是共享 token，不按人登录。 */
  async #publishHub(shard) {
    await http(`${this.config.hub}/shard`, {
      method: 'PUT', body: JSON.stringify(shard), headers: this.#hubAuth(),
    });
  }

  /** hub：一次 GET 拿全部分片，剔掉自己，顺手落缓存供冷启动。 */
  async #fetchHub() {
    const all = await http(`${this.config.hub}/shards`, { headers: this.#hubAuth() });
    const shards = (Array.isArray(all) ? all : []).filter((s) => this.#isForeign(s));
    try { writeFileSync(this.cacheFile, JSON.stringify(shards)); } catch { /* 缓存写不进去不影响本轮 */ }
    return shards;
  }

  #hubAuth() { return this.config?.token ? { authorization: `Bearer ${this.config.token}` } : {}; }

  /**
   * hub：把本机**流水增量**推给服务器。
   *
   * 与分片分开：分片是聚合（三张卡够用），流水是明细——hub 手里有了明细，才谈得上「后端管理
   * 对账」（全账号逐点对账）与「每个任务花了多少」。两者都是幂等 PUT，谁失败都不连带另一个。
   *
   * 只走 hub 通道：收件口（Cloudflare KV）那条路按同一套行格式收流水块是后面的事。
   * @returns {number} 服务端采纳（新插入）的行数；没配/失败一律 0，调用方据此决定要不要退水位
   */
  async pushJournal(rows, { machineId = null } = {}) {
    if (this.config?.mode !== 'hub' || !Array.isArray(rows) || !rows.length) return 0;
    const r = await http(`${this.config.hub}/journal`, {
      method: 'PUT', headers: this.#hubAuth(),
      body: JSON.stringify({ machineId: machineId ?? this.machineId, installId: this.installId, rows }),
    });
    return Number(r?.accepted) || 0;
  }

  /**
   * 把本机读到的账号额度推给 hub。只有跑着 Mirasim 的机器调得动这条——
   * 额度点是账号级的，服务器自己没有 Mirasim，这份数据只能由这样的机器送上去。
   *
   * 与分片分开发：分片是这台机器的账本（它自己的事），额度是全账号的事，
   * 一台机器账本推失败不该连带把额度也丢了，反之亦然。失败静默（调用方只当这轮没推成）。
   * @returns true 表示服务端采纳了（比在架的更新）
   */
  async pushLimits(limits) {
    if (this.config?.mode !== 'hub' || !limits?.windows?.length) return false;
    try {
      const r = await http(`${this.config.hub}/limits`, {
        method: 'PUT', headers: this.#hubAuth(),
        body: JSON.stringify({ ...limits, machineId: this.machineId, installId: this.installId }),
      });
      return !!r?.accepted;
    } catch { return false; }
  }

  /** 收件口：发布就是一次 PUT；分片里带 account/installId，Worker 据此定分支名。 */
  async #publishInbox(shard) {
    const { inbox, account, passphrase } = this.config;
    await http(`${inbox}/shard`, {
      method: 'PUT', body: JSON.stringify(shard),
      headers: { 'x-account': account, 'x-passphrase': passphrase },
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
    try {
      // HTTP 两条通道没有本地仓，冷启动只有缓存这一份
      const cached = () => {
        try { return JSON.parse(readFileSync(this.cacheFile, 'utf8')).filter((s) => this.#isForeign(s)); } catch { return []; }
      };
      const shards = cached();
      if (shards.length) this.shards = shards;
      return shards;
    } catch { return []; }
  }

  /**
   * 一轮同步：发布本机分片 + 读回全部外机分片，两条链分开记（发布成功只读取失败是中间态）。
   * 任何失败都不抛，只记入 lastError；上一轮读到的分片保留（远端临时不可达时合并口径不回退）。
   * 返回 status() 的全部字段外加 shards，功能关闭时返回 null。
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
      await retryOnce(() => this.#publishTo(shard), this.retryDelayMs);
      this.lastPublishSec = nowSec;   // 发布已成功，即使随后读取失败也算数
      this.pushOk = true;
    } catch (e) { this.pushOk = false; err = firstLine(e); }
    // 发布都推不上去时同一端点的读取几无成功可能，省一次网络往返直接跳过。
    if (this.pushOk) {
      try {
        this.shards = await retryOnce(() => this.#fetchAll(), this.retryDelayMs);
        this.lastSyncSec = nowSec;
      } catch (e) { err = firstLine(e); }
    }
    this.lastError = err;
    this.failStreak = err ? this.failStreak + 1 : 0;
    return { ...this.status(nowSec), shards: this.shards };
  }

  /**
   * 只读一轮：不发布本机分片，只把他机分片重新拉一遍。
   *
   * 用在「本机 Mirasim 没在跑」的时候——这台机器自己的账本几乎不动（没有 relay 在扣点），
   * 没什么可发的，但账号额度得跟上还在跑的那台机器。省掉 push 那半程，就只剩
   * 一次 fetch，快节奏拉取（quotaIntervalSec）才不至于把远端仓刷成提交流水。
   *
   * 失败静默：状态色仍由 run() 那条主链判——一次额外的读取失败不该让界面变红，
   * 上一轮读到的分片也照旧留在内存里参与合并。
   * @returns 读到的外机分片；失败返回 null（调用方据此不动任何状态）
   */
  async refreshOnly(nowSec = Date.now() / 1000) {
    if (!this.enabled) return null;
    try {
      this.shards = await this.#fetchAll();
      this.lastSyncSec = nowSec;
      return this.shards;
    } catch { return null; }
  }

  /**
   * 发布 / 读取按通道分派。写成表而不是布尔判断：加第三条通道时改这两处，
   * 不用满文件找 `inbox ? … : …`（这个坑在加 hub 时就已经踩到了）。
   */
  #publishTo(shard) {
    if (this.mode === 'hub') return this.#publishHub(shard);
    if (this.mode === 'inbox') return this.#publishInbox(shard);
    return Promise.reject(new Error(`不认识的同步通道：${this.mode}`));
  }

  #fetchAll() {
    if (this.mode === 'hub') return this.#fetchHub();
    if (this.mode === 'inbox') return this.#fetchInbox();
    return Promise.reject(new Error(`不认识的同步通道：${this.mode}`));
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
   *    key 是 installId（没有就退回 id，老分片），account 是自报名字（hub 通道为 null）。
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
      ...(this.mode === 'hub' ? { hub: this.config.hub } : {}),
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
