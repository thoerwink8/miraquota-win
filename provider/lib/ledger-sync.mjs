/**
 * 多机账本同步：每台机器把本机账本聚合态（分钟桶）作为分片，与其他机器互读。
 * 点数是账号级、账本是本机级，多台机器共用额度时「本机$ ÷ 账号点」系统性偏低——
 * 合并全机分片后，标定/归因/强度的分子才与账号级点数同口径（见 docs/MULTI-MACHINE.md）。
 *
 * 两种通道，配置文件 ~/.miraquota/sync.json 决定走哪条：
 *  - git 通道 { remote }：本机 GitHub 凭据直推私有仓，每台机器只写 machine/<machineId> 分支，
 *    单提交覆盖不留历史（首次 commit，之后 commit --amend + push --force），仓库体积恒定；
 *  - 收件口通道 { inbox, account, passphrase }（2026-09-02 用户拍板）：没有 GitHub 的人走这里。
 *    客户端零仓库凭据，只带自报名字 + 自设口令，HTTP 推给 Cloudflare Worker，分片存它的 KV
 *    （见 inbox/worker.mjs），Worker 也不需要 GitHub 令牌。读他机从收件口一次拿全；
 *    git 通道的机器读远端分支之余也顺带读一次收件口，两条通道的人在同一张多机页上。
 *  - 文件不存在、或既无 remote 也无 inbox ⇒ 功能完全关闭，零副作用。
 *
 * 故障呈现取舍（2026-09-01 实测：本地代理偶发 SSL_ERROR_SYSCALL，紧接着的六次访问全成功）：
 * 抖动不该报红——红色只留给用户真要处置的持续故障。三道闸依次拦：
 *  ① 单轮内短退避重试一次；② 发布成功而只读取失败算中间态（本机数据已上传，合并样本少一点而已）；
 *  ③ 仍失败要连续 ERROR_STREAK 轮、或上次成功已过期，才进 error。
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';

const CONFIG_FILE = join(homedir(), '.miraquota', 'sync.json');
const REPO_DIR = join(homedir(), '.miraquota', 'sync-repo');
const INSTALL_FILE = join(homedir(), '.miraquota', 'install.json');
const INBOX_CACHE = join(homedir(), '.miraquota', 'inbox-shards.json');
const SHARD_FILE = 'shard.json';
const DEFAULT_INTERVAL = 600;   // 秒；sync.json 未写 intervalSec 时的节流间隔
const RETRY_DELAY_MS = 2000;    // 单轮内退避重试的等待
const ERROR_STREAK = 2;         // 连续失败达到这个轮数才进 error（红），此前是重试中（黄）
const HTTP_TIMEOUT_MS = 30_000;
export const SHARD_SCHEMA = 1;

/**
 * 新机器免手写配置：没有 sync.json 时先静默探一下这个仓能不能读，能读才自动接入
 * （2026-09-02 用户拍板）。地址写在这里是有意的——仓是私有的，读得动的前提是那台机器
 * 本来就有本人的 GitHub 凭据；陌生人装了公开版探测必然失败，于是什么都不发生，
 * 与今天「没配置就整个功能关闭」的行为逐字一致。不想自动接入见 AUTOJOIN_OFF。
 */
export const DEFAULT_REMOTE = 'https://github.com/thoerwink8/miraquota-ledger.git';
/**
 * 默认收件口。部署 inbox/ 后把 workers.dev 地址填到这里；多机页的登录框预填它、允许改。
 * 地址本身不是秘密（Worker 只认名字+口令+邀请码），放在公开代码里没关系。
 */
export const DEFAULT_INBOX = 'https://miraquota-inbox.REPLACE-ME.workers.dev';
/** 探测超时；托盘常驻应用后台跑，宁可等久一点也不要因为网络慢误判成「不能接」。 */
const PROBE_TIMEOUT_MS = 20_000;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * 单轮内退避重试一次：网络抖动不该被记成一次失败。
 * 代价：git 调用自带 30s 超时，重试后单步最坏 ~62s，仍远小于同步间隔（默认 600s），
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
  [/repository not found|not found|not appear to be a git repos|no such endpoint|404/i, '仓库/收件口地址不对或已不存在'],
  [/ssl|unable to access|could not resolve host|resolve|timed out|timeout|connection (?:reset|refused|closed)|network is unreachable|proxy|failed to connect|fetch failed|aborted/i,
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

/**
 * 后台跑的 git 一律禁止任何交互：托盘应用弹不出终端，凭据管理器却可能弹出登录窗口，
 * 用户看到的是「我没干什么，突然要我登 GitHub」。凭据已存在则照常走 helper，不受影响。
 */
const NO_PROMPT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',      // 问密码就返回空 → 立刻失败，不弹窗
  GCM_INTERACTIVE: 'never', // Windows 凭据管理器不弹登录界面
};

/** 系统 git CLI。stderr 并入报错信息，供 payload 的 sync.error 展示一行。 */
const git = (cwd, args, timeout = 30_000) => new Promise((resolve, reject) => {
  execFile('git', ['-C', cwd, ...args],
    { timeout, maxBuffer: 8 << 20, windowsHide: true, env: NO_PROMPT_ENV },
    (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || err).trim() || 'git 失败'));
      else resolve(String(stdout));
    });
});

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
   * @param opts.repoDir    同步仓工作目录（默认 ~/.miraquota/sync-repo）
   * @param opts.machineId  机器短名（默认 os.hostname() 清洗）
   * @param opts.installId  安装 id（默认读/生成 ~/.miraquota/install.json）
   * @param opts.cacheFile  收件口分片缓存（默认 ~/.miraquota/inbox-shards.json）
   * @param opts.inboxUrl   git 通道顺带读分片的收件口（默认 DEFAULT_INBOX；传 null 关掉）
   * @param opts.retryDelayMs 单轮内重试的等待（测试注入用，默认 2 秒）
   */
  constructor({ configFile = CONFIG_FILE, repoDir = REPO_DIR, machineId = cleanMachineId(),
    installId = null, installFile = INSTALL_FILE, cacheFile = INBOX_CACHE, inboxUrl = DEFAULT_INBOX,
    retryDelayMs = RETRY_DELAY_MS } = {}) {
    this.inboxUrl = inboxUrl;
    this.configFile = configFile;
    this.repoDir = repoDir;
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
    this.autoJoined = !!this.config?.autoJoinedAt;   // 配置是自动接入写的（UI 交代一句来源）
  }

  /** 文件不存在、解析失败、既无 remote 也无 inbox ⇒ 功能关闭（硬性验收：现行为零变化）。 */
  #loadConfig() {
    try {
      const c = JSON.parse(readFileSync(this.configFile, 'utf8'));
      const interval = Number(c?.intervalSec);
      const intervalSec = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL;
      if (typeof c?.inbox === 'string' && c.inbox.trim() && ACCOUNT_RE.test(c.account ?? '')
        && typeof c.passphrase === 'string' && c.passphrase.length >= 4) {
        return { mode: 'inbox', inbox: c.inbox.trim().replace(/\/+$/, ''), account: c.account, passphrase: c.passphrase, intervalSec };
      }
      if (typeof c?.remote !== 'string' || !c.remote.trim()) return null;
      return {
        mode: 'git',
        remote: c.remote.trim(),
        intervalSec,
        // 自动接入写下的来源标记，重启后仍认得出（UI 据此说明这台机器是自己接上的）
        ...(typeof c.autoJoinedAt === 'string' ? { autoJoinedAt: c.autoJoinedAt } : {}),
      };
    } catch { return null; }
  }

  get enabled() { return !!this.config; }
  get mode() { return this.config?.mode ?? null; }
  get intervalSec() { return this.config?.intervalSec ?? DEFAULT_INTERVAL; }
  /** 分片上的身份：收件口模式带 account，两种模式都带 installId。 */
  get identity() {
    return { installId: this.installId, ...(this.config?.mode === 'inbox' ? { account: this.config.account } : {}) };
  }

  /**
   * 新机器自动接入：没有 sync.json 时，静默探一下默认仓能不能读，能读才写配置并启用。
   *
   * 三条硬边界——
   *  ① 文件存在就一律不动（哪怕内容是空的、坏的、autoJoin:false）：用户配过的就是他说了算；
   *  ② 探测用 git ls-remote，只读、不建仓、不留痕，失败就当没发生过（不记 error、不进界面），
   *     这样陌生人装公开版仍是「整个功能关闭」，与今天零差别；
   *  ③ 写进去的 remote 和探通的是同一个地址，不给「探 A 用 B」留缝。
   *
   * @returns true 表示本次接上了（调用方据此放宽归因静置），其余情况一律 false。
   */
  async tryAutoJoin({ remote = DEFAULT_REMOTE, now = new Date() } = {}) {
    if (this.enabled || existsSync(this.configFile) || !remote) return false;
    try {
      await git(homedir(), ['ls-remote', '--heads', remote], PROBE_TIMEOUT_MS);
    } catch { return false; }   // 没凭据/没网/不是这台机器该管的仓：静默作罢，下次再探
    try {
      mkdirSync(join(this.configFile, '..'), { recursive: true });
      writeFileSync(this.configFile, JSON.stringify({
        remote,
        intervalSec: DEFAULT_INTERVAL,
        // 留个来源标记：以后看到这台机器怎么接上的，不用猜（也让 UI 能说一句人话）
        autoJoinedAt: now.toISOString(),
      }, null, 2) + '\n');
    } catch { return false; }
    this.config = this.#loadConfig();
    this.autoJoined = this.enabled;
    return this.enabled;
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
    this.autoJoined = false;
    this.lastError = null; this.failStreak = 0;
    return { ok: true, registered };
  }

  /** 同步仓就绪：init + repo 级身份（不碰全局配置）+ origin 对齐 sync.json 的 remote。 */
  async #ensureRepo() {
    if (!existsSync(join(this.repoDir, '.git'))) {
      mkdirSync(this.repoDir, { recursive: true });
      await git(this.repoDir, ['init', '--quiet']);
    }
    // 这三项每轮都幂等重设，不放在 init 分支里：实测首次 init 后进程提前退出（--once），
    // config 没落盘，之后每轮都以「.git 已存在」跳过补写，永久缺失——提交会署用户全局
    // git 身份，用户若开了 GPG 签名则 commit 直接失败。三次本地 git config 很便宜。
    await git(this.repoDir, ['config', 'user.name', 'miraquota']);
    await git(this.repoDir, ['config', 'user.email', 'miraquota@local']);
    await git(this.repoDir, ['config', 'commit.gpgsign', 'false']);
    const remotes = (await git(this.repoDir, ['remote'])).split('\n').map((s) => s.trim());
    if (!remotes.includes('origin')) {
      await git(this.repoDir, ['remote', 'add', 'origin', this.config.remote]);
    } else if ((await git(this.repoDir, ['remote', 'get-url', 'origin'])).trim() !== this.config.remote) {
      await git(this.repoDir, ['remote', 'set-url', 'origin', this.config.remote]);
    }
  }

  /** 发布本机分片：单提交覆盖不留历史，远端 machine/<id> 分支恒为一个提交。 */
  async #publish(shard) {
    writeFileSync(join(this.repoDir, SHARD_FILE), JSON.stringify(shard));
    await git(this.repoDir, ['add', SHARD_FILE]);
    const hasHead = await git(this.repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      .then(() => true, () => false);
    const msg = `shard ${this.machineId} @ ${new Date(shard.generatedAt * 1000).toISOString()}`;
    // --allow-empty：内容未变时也要能提交（覆盖区间在分片里、时间戳在 message 里，都在变）。
    await git(this.repoDir, hasHead
      ? ['commit', '--amend', '--allow-empty', '--quiet', '-m', msg]
      : ['commit', '--allow-empty', '--quiet', '-m', msg]);
    // force 只作用于同步数据仓自己的 machine/<id> 分支——它就是「覆盖式发布」的语义。
    await git(this.repoDir, ['push', '--quiet', '--force', 'origin', `HEAD:machine/${this.machineId}`]);
  }

  /** 读全部外机分片：fetch machine/* 后逐分支 git show，坏分片跳过不拖垮整轮。 */
  async #fetchForeign() {
    await git(this.repoDir, ['fetch', '--quiet', '--prune', 'origin',
      '+refs/heads/machine/*:refs/remotes/origin/machine/*']);
    return this.#mergeShards(await this.#readForeignRefs(), await this.#readInboxQuietly());
  }

  /**
   * git 通道的机器也看得见收件口的人：分片存在 Worker 的 KV 里，不在仓里，所以 fetch 拿不到。
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

  /** 收件口：发布就是一次 PUT；分片里带 account/installId，Worker 据此定分支名。 */
  async #publishInbox(shard) {
    const { inbox, account, passphrase } = this.config;
    await http(`${inbox}/shard`, {
      method: 'PUT', body: JSON.stringify(shard),
      headers: { 'x-account': account, 'x-passphrase': passphrase },
    });
  }

  /** 收件口：一次 GET 拿全部分片（含 git 通道机器的），剔掉自己，顺手落缓存供冷启动。 */
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
      const cached = () => {
        try { return JSON.parse(readFileSync(this.cacheFile, 'utf8')).filter((s) => this.#isForeign(s)); } catch { return []; }
      };
      let shards;
      if (this.mode === 'inbox') {
        shards = cached();
      } else {
        shards = this.#mergeShards(existsSync(join(this.repoDir, '.git')) ? await this.#readForeignRefs() : [], cached());
      }
      if (shards.length) this.shards = shards;
      return shards;
    } catch { return []; }
  }

  /** 本地 refs/remotes/origin/machine/* 里的分片，逐个 git show，坏分片跳过。 */
  async #readForeignRefs() {
    const refs = (await git(this.repoDir, ['for-each-ref', '--format=%(refname)',
      'refs/remotes/origin/machine/'])).split('\n').map((s) => s.trim()).filter(Boolean);
    const shards = [];
    for (const ref of refs) {
      const id = ref.slice('refs/remotes/origin/machine/'.length);
      if (id === this.machineId) continue;
      try {
        const shard = JSON.parse(await git(this.repoDir, ['show', `${ref}:${SHARD_FILE}`]));
        // v1 聚合态与 v2 原始行都收；账本那边负责把 v2 定价落成 v1
        if ((shard?.schemaVersion !== SHARD_SCHEMA && shard?.schemaVersion !== 2) || !shard.machineId) continue;
        if (!this.#isForeign(shard)) continue;
        shards.push(shard);
      } catch { /* 单个分片坏不影响其余机器 */ }
    }
    return shards;
  }

  /**
   * 一轮同步：发布本机分片 + 读回全部外机分片，两条链分开记（发布成功只读取失败是中间态）。
   * 任何失败都不抛，只记入 lastError；上一轮读到的分片保留（远端临时不可达时合并口径不回退）。
   * 返回 status() 的全部字段外加 shards，功能关闭时返回 null。
   */
  async run(ledger, nowSec = Date.now() / 1000) {
    if (!this.enabled) return null;
    const firstLine = (e) => String(e.message || e).split('\n')[0].slice(0, 200);
    const inbox = this.mode === 'inbox';
    let err = null;
    try {
      if (!inbox) await this.#ensureRepo();
      const shard = ledger.exportShard(this.machineId, nowSec, this.identity);
      await retryOnce(() => (inbox ? this.#publishInbox(shard) : this.#publish(shard)), this.retryDelayMs);
      this.lastPublishSec = nowSec;   // 发布已成功，即使随后读取失败也算数
      this.pushOk = true;
    } catch (e) { this.pushOk = false; err = firstLine(e); }
    // 发布都推不上去时同一端点的读取几无成功可能，省一次网络往返直接跳过。
    if (this.pushOk) {
      try {
        this.shards = await retryOnce(() => (inbox ? this.#fetchInbox() : this.#fetchForeign()), this.retryDelayMs);
        this.lastSyncSec = nowSec;
      } catch (e) { err = firstLine(e); }
    }
    this.lastError = err;
    this.failStreak = err ? this.failStreak + 1 : 0;
    return { ...this.status(nowSec), shards: this.shards };
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
   *    key 是 installId（没有就退回 id，老分片），account 是自报名字（git 通道为 null）。
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
        })),
      ],
      ...(this.autoJoined ? { autoJoined: true } : {}),
      ...(this.lastSyncSec != null ? { lastSyncSec: this.lastSyncSec } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(hint ? { errorHint: hint } : {}),
      ...(this.failStreak > 0 ? { failStreak: this.failStreak } : {}),
    };
  }
}
