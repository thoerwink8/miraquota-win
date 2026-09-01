/**
 * 多机账本同步：每台机器把本机账本聚合态（分钟桶）作为分片，经一个私有 Git 仓互读。
 * 点数是账号级、账本是本机级，多台机器共用额度时「本机$ ÷ 账号点」系统性偏低——
 * 合并全机分片后，标定/归因/强度的分子才与账号级点数同口径（见 docs/MULTI-MACHINE.md）。
 *
 * 通道取舍：
 *  - 每台机器只写自己的分支 machine/<machineId>，互不冲突，无合并逻辑；
 *  - 单提交覆盖不留历史（首次 commit，之后 commit --amend + push --force），
 *    仓库体积恒定，不需要清理任务；
 *  - 读他机只 fetch machine/* 远程分支并 git show 文件内容，工作区永远只有本机分片；
 *  - 配置文件 ~/.miraquota/sync.json 不存在或无 remote ⇒ 功能完全关闭，零副作用。
 *
 * 故障呈现取舍（2026-09-01 实测：本地代理偶发 SSL_ERROR_SYSCALL，紧接着的六次访问全成功）：
 * 抖动不该报红——红色只留给用户真要处置的持续故障。三道闸依次拦：
 *  ① 单轮内短退避重试一次；② 发布成功而只读取失败算中间态（本机数据已上传，合并样本少一点而已）；
 *  ③ 仍失败要连续 ERROR_STREAK 轮、或上次成功已过期，才进 error。
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const CONFIG_FILE = join(homedir(), '.miraquota', 'sync.json');
const REPO_DIR = join(homedir(), '.miraquota', 'sync-repo');
const SHARD_FILE = 'shard.json';
const DEFAULT_INTERVAL = 600;   // 秒；sync.json 未写 intervalSec 时的节流间隔
const RETRY_DELAY_MS = 2000;    // 单轮内退避重试的等待
const ERROR_STREAK = 2;         // 连续失败达到这个轮数才进 error（红），此前是重试中（黄）
export const SHARD_SCHEMA = 1;

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
 * 常见 git 报错的人话归纳。原始报错另存 sync.error 当次要小字，人话丢原文更难查。
 * 顺序有讲究：权限类报错常同时含 'unable to access'，必须先判权限再判网络。
 */
const ERROR_HINTS = [
  [/authentication|could not read username|invalid credentials|403|permission|denied/i, '凭据无效或无权限'],
  [/repository not found|not found|not appear to be a git repos/i, '仓库地址不对或已不存在'],
  [/ssl|unable to access|could not resolve host|resolve|timed out|timeout|connection (?:reset|refused|closed)|network is unreachable|proxy|failed to connect/i,
    '网络连不上 GitHub（代理或网络问题）'],
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

/** 系统 git CLI。stderr 并入报错信息，供 payload 的 sync.error 展示一行。 */
const git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', cwd, ...args],
    { timeout: 30_000, maxBuffer: 8 << 20, windowsHide: true },
    (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || err).trim() || 'git 失败'));
      else resolve(String(stdout));
    });
});

export class LedgerSync {
  /**
   * @param opts.configFile 配置文件路径（测试注入用，默认 ~/.miraquota/sync.json）
   * @param opts.repoDir    同步仓工作目录（默认 ~/.miraquota/sync-repo）
   * @param opts.machineId  机器短名（默认 os.hostname() 清洗）
   * @param opts.retryDelayMs 单轮内重试的等待（测试注入用，默认 2 秒）
   */
  constructor({ configFile = CONFIG_FILE, repoDir = REPO_DIR, machineId = cleanMachineId(),
    retryDelayMs = RETRY_DELAY_MS } = {}) {
    this.configFile = configFile;
    this.repoDir = repoDir;
    this.machineId = machineId;
    this.retryDelayMs = retryDelayMs;
    this.shards = [];          // 最近一次 fetch 到的外机分片（内存缓存）
    this.lastSyncSec = null;   // 最近一次成功同步的时刻（发布＋读取都成）
    this.lastPublishSec = null; // 本机分片最近一次成功发布（push 成功）的时刻
    this.lastError = null;
    this.pushOk = false;       // 最近一轮本机分片是否推送成功（区分「只是读不到他机」）
    this.failStreak = 0;       // 连续失败轮数：抖动一次不报红，达 ERROR_STREAK 才报
    this.config = this.#loadConfig();
  }

  /** 文件不存在、解析失败或无 remote ⇒ 功能关闭（硬性验收：现行为零变化）。 */
  #loadConfig() {
    try {
      const c = JSON.parse(readFileSync(this.configFile, 'utf8'));
      if (!c || typeof c.remote !== 'string' || !c.remote.trim()) return null;
      const interval = Number(c.intervalSec);
      return {
        remote: c.remote.trim(),
        intervalSec: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL,
      };
    } catch { return null; }
  }

  get enabled() { return !!this.config; }
  get intervalSec() { return this.config?.intervalSec ?? DEFAULT_INTERVAL; }

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
    const refs = (await git(this.repoDir, ['for-each-ref', '--format=%(refname)',
      'refs/remotes/origin/machine/'])).split('\n').map((s) => s.trim()).filter(Boolean);
    const shards = [];
    for (const ref of refs) {
      const id = ref.slice('refs/remotes/origin/machine/'.length);
      if (id === this.machineId) continue;
      try {
        const shard = JSON.parse(await git(this.repoDir, ['show', `${ref}:${SHARD_FILE}`]));
        if (shard?.schemaVersion !== SHARD_SCHEMA || !shard.machineId) continue; // 未来版本不硬解
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
    let err = null;
    try {
      await this.#ensureRepo();
      await retryOnce(() => this.#publish(ledger.exportShard(this.machineId, nowSec)), this.retryDelayMs);
      this.lastPublishSec = nowSec;   // 发布已 push 成功，即使随后 fetch 失败也算数
      this.pushOk = true;
    } catch (e) { this.pushOk = false; err = firstLine(e); }
    // push 都推不上去时同一 remote 的 fetch 几无成功可能，省一次网络往返直接跳过。
    if (this.pushOk) {
      try {
        this.shards = await retryOnce(() => this.#fetchForeign(), this.retryDelayMs);
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
   *  - machines：每台机器一行 { id, lastShardSec, self }——本机取最近一次成功发布时刻，
   *    外机取其分片的 generatedAt；从未发布/无分片时为 null。
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
      pushOk: this.pushOk,
      intervalSec: this.intervalSec,   // 显示面据此判「分片超过 2×interval 未更新 ⇒ 已过期」
      machines: [
        { id: this.machineId, lastShardSec: this.lastPublishSec, self: true },
        ...this.shards.map((s) => ({ id: s.machineId, lastShardSec: s.generatedAt, self: false })),
      ],
      ...(this.lastSyncSec != null ? { lastSyncSec: this.lastSyncSec } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(hint ? { errorHint: hint } : {}),
      ...(this.failStreak > 0 ? { failStreak: this.failStreak } : {}),
    };
  }
}
