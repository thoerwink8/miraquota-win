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
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const CONFIG_FILE = join(homedir(), '.miraquota', 'sync.json');
const REPO_DIR = join(homedir(), '.miraquota', 'sync-repo');
const SHARD_FILE = 'shard.json';
const DEFAULT_INTERVAL = 600;   // 秒；sync.json 未写 intervalSec 时的节流间隔
export const SHARD_SCHEMA = 1;

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
   */
  constructor({ configFile = CONFIG_FILE, repoDir = REPO_DIR, machineId = cleanMachineId() } = {}) {
    this.configFile = configFile;
    this.repoDir = repoDir;
    this.machineId = machineId;
    this.shards = [];        // 最近一次 fetch 到的外机分片（内存缓存）
    this.lastSyncSec = null; // 最近一次成功同步的时刻
    this.lastError = null;
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
      await git(this.repoDir, ['config', 'user.name', 'miraquota']);
      await git(this.repoDir, ['config', 'user.email', 'miraquota@local']);
      // 数据仓的提交是机器自动产物，不该被用户的全局签名配置卡住（无钥匙时 commit 直接失败）。
      await git(this.repoDir, ['config', 'commit.gpgsign', 'false']);
    }
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
   * 一轮同步：发布本机分片 + 读回全部外机分片。任何失败都不抛，只记入 lastError；
   * 上一轮读到的分片保留（远端临时不可达时合并口径不回退）。
   * 返回 { machines, lastSyncSec, shards, error? }，功能关闭时返回 null。
   */
  async run(ledger, nowSec = Date.now() / 1000) {
    if (!this.enabled) return null;
    try {
      await this.#ensureRepo();
      await this.#publish(ledger.exportShard(this.machineId, nowSec));
      this.shards = await this.#fetchForeign();
      this.lastSyncSec = nowSec;
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e.message || e).split('\n')[0].slice(0, 200);
    }
    return { ...this.status(), shards: this.shards };
  }

  /** payload 的 sync 字段：机器数（含本机）、最近同步时刻、失败原因。 */
  status() {
    return {
      machines: 1 + this.shards.length,
      ...(this.lastSyncSec != null ? { lastSyncSec: this.lastSyncSec } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}
