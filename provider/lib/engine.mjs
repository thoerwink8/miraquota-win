/**
 * 数据引擎：采集（/v1/limits 发现 + 令牌自动发现）与结论组装（契约 A 的 quota.json）。
 * CLI provider 与 Electron 桌面版共用这一份，两个显示面不各算一套口径。
 *
 * 降级阶梯（Mirasim 关闭时仍有可读输出）：
 *   exact  /v1/limits 可读，原始额度点
 *   stale  接口刚断，显示最后一次实测（内存）
 *   reckoned  Mirasim 不可达，按落盘锚点滚动窗口 + 本机账本推算（下界，标 ≈）
 *   local  连锚点都没有，按滚动窗口报本机支出
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Pricing } from './pricing.mjs';
import { CostLedger } from './ledger.mjs';
import { LedgerSync, DEFAULT_INBOX } from './ledger-sync.mjs';
import { PointsAttributor } from './points-attrib.mjs';
import { familyLabel } from './model-families.mjs';
import { Calibrator } from './calibrator.mjs';
import { evaluateCoherence, coherenceNotice, measureGroupRatio, weightedSpend } from './coherence.mjs';

/**
 * 官方汇率：额度点 ÷ 100 = 美元（560000→5600、156800→1568、296800→2968 三窗都整除）。
 * 2026-09-02 用户向官方求证确认。此前满额靠「本机账本 ÷ 已用点」反推，有两处硬伤：
 * 账本漏一点满额就同倍缩水（实测偏 -3.5%），而 Mirasim 一停就退到另一套中位数算法
 * （实测报 2837 而非 5600）。改成官方除法后三条 payload 路径同一个数，且不依赖账本。
 * 反推不删——它与这个常量的偏离就是「账本漏了多少」的读数，降级为对账检查。
 */
export const OFFICIAL_PER_POINT = 0.01;

const MIRASIM_SETTING = join(homedir(), '.mirasim', 'setting.json');

/**
 * Mirasim「原生模型」页勾选的模型清单（本地 setting.json 的 enabledModels）。
 * 用途只有一个：对表价目表，把「已启用但账本没价」的模型提前点名——它一旦经 relay 被用到，
 * 账本只能记 token 记不了美元。用户 2026-09-02：本地就能读到支持的模型，别等漏了才知道。
 * @returns { models: string[], unpriced: string[] } | null（文件不在或不可读）
 */
export function readEnabledModels(pricing, file = MIRASIM_SETTING) {
  let root;
  try { root = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const em = root?.enabledModels;
  if (!em || typeof em !== 'object') return null;
  const models = [...new Set(Object.values(em).flat().filter((m) => typeof m === 'string' && m))];
  const unpriced = models.filter((m) => pricing.price(m) == null);
  return { models, unpriced };
}
import { Settings } from './settings.mjs';
import { discoverSessionTokens } from './session-token.mjs';
import { windowDuration, modelGroup } from './windows.mjs';
import { AnchorStore, anchorsFrom, ANCHOR_MAX_AGE } from './anchors.mjs';

const CHANNEL_DEFAULT = 4970;
const STALE_AFTER = 90;      // 秒；超过转 stale
const RECKON_AFTER = 600;    // 秒；stale 超过此龄期转锚点推算
const AUTOJOIN_EVERY = 3600; // 秒；未配置多机同步时，隔多久静默探一次默认仓能不能读
export const LEVELS = {
  exact: '精确', stale: '已过期', reckoned: '推算', local: '无数据', connecting: '连接中',
};

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 8000, maxBuffer: 8 << 20, windowsHide: true },
    (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
});

const getJSON = async (url, ms = 2500, headers = undefined) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Mirasim 进程（pid 与命令行）。命令行里带 server.cjs 的才算。 */
async function mirasimProcesses() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*server.cjs*" } |' +
      ' Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress']);
    if (!out.trim()) return [];
    let parsed;
    try { parsed = JSON.parse(out); } catch { return []; }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((r) => ({ pid: Number(r.ProcessId), cmd: String(r.CommandLine || '') }));
  }
  const out = await run('/bin/ps', ['-axo', 'pid=,command=']);
  return out.split('\n').filter((l) => l.includes('server.cjs')).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), cmd: m[2] } : null;
  }).filter(Boolean);
}

/** 指定 pid 集合持有的回环监听端口。 */
async function listeningPorts(pids) {
  const byPid = new Map(pids.map((p) => [p, []]));
  const add = (pid, port) => { if (byPid.has(pid)) byPid.get(pid).push(port); };
  if (process.platform === 'win32') {
    const out = await run('netstat.exe', ['-ano', '-p', 'TCP']);
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m) add(Number(m[2]), Number(m[1]));
    }
  } else {
    const out = await run('ss', ['-Hltnp']);
    for (const line of out.split('\n')) {
      const port = line.match(/127\.0\.0\.1:(\d+)/);
      const pid = line.match(/pid=(\d+)/);
      if (port && pid) add(Number(pid[1]), Number(port[1]));
    }
  }
  return byPid;
}

/** 解析 /v1/limits。reset_at 归一化，越界窗口丢弃。 */
export function parseLimits(root) {
  if (!root || !Array.isArray(root.windows)) return null;
  const now = Date.now() / 1000;
  const windows = [];
  for (const w of root.windows) {
    const used = num(w.used), budget = num(w.budget);
    let reset = num(w.reset_at);
    if (used == null || budget == null || budget <= 0 || reset == null || !w.name) continue;
    if (reset > 1e11) reset /= 1000;
    if (reset < now - 86400 || reset > now + 30 * 86400) continue;
    windows.push({
      label: String(w.name), used, budget, resetAt: reset,
      modelScoped: (w.model_scoped === true) || (w.modelScoped === true),
    });
  }
  if (!windows.length) return null;
  return { windows, suspended: !!root.suspended, unmetered: !!root.unmetered, degraded: !!root.degraded };
}

export class Engine {
  /**
   * @param opts.routerPort  指定路由端口，跳过发现
   * @param opts.routerToken 指定会话令牌（否则 Windows 走 PEB 自动发现）
   * @param opts.forceOffline 强制离线（验证降级路径用）
   * @param opts.syncOpts    多机账本同步的路径注入（测试用，默认走 ~/.miraquota）
   * @param opts.ledgerFile  账本落盘路径（默认 ~/.miraquota/ledger.json）
   * @param opts.anchorFile  锚点落盘路径（默认 ~/.miraquota/anchor.json）
   * @param opts.noLocal     不扫本机 transcript 与网关账本。服务端 hub 用：那台机器上
   *   没有任何人的会话记录，账本全部来自各机推上来的分片，扫本地只是白跑一趟。
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.pricing = new Pricing();
    this.ledger = new CostLedger(this.pricing, opts.ledgerFile);
    this.pointsAttrib = new PointsAttributor();
    this.calibrator = new Calibrator();
    this.anchors = new AnchorStore(opts.anchorFile);
    this.settings = new Settings(opts.settingsFile);
    this.sync = new LedgerSync(opts.syncOpts);
    // 同步启用时放宽归因静置：外机支出要等它下一轮发布分片才可见（见 points-attrib.mjs）。
    if (this.sync.enabled) this.pointsAttrib.relaxSettle(this.sync.intervalSec);
    this.speed = null;
    this.cachedRouter = null;
    this.last = null;           // { at, limits }
    // 他机分片带来的账号级额度快照（最新的一份）：本机连不上 Mirasim 时的额度来源
    this.foreignLimits = null;  // { capturedAt, windows, machineId, account, suspended… }
    this.pointsTrail = {};
    this.everConnected = false;
  }

  #syncBusy = false;
  #syncKickedAt = 0;
  #shardsWarmed = false;
  #autoJoinBusy = false;
  #autoJoinAt = 0;
  #quotaPullBusy = false;
  #quotaPullAt = 0;

  /**
   * 没配置多机同步时，隔一阵静默探一次默认仓能不能读，能读就自己接上（见 ledger-sync）。
   * 探不通什么都不发生，所以这里不记状态、不进 payload——用户看到的仍是「没有多机页」。
   * 首次在启动后第一跳就探（#autoJoinAt=0），之后每 AUTOJOIN_EVERY 一次：
   * 这台机器刚 gh auth login 完，不用重启应用也能在下一轮自己接上。
   */
  #maybeAutoJoin(now) {
    if (this.#autoJoinBusy || now - this.#autoJoinAt < AUTOJOIN_EVERY) return;
    this.#autoJoinAt = now;
    this.#autoJoinBusy = true;
    this.sync.tryAutoJoin()
      .then((joined) => { if (joined) this.pointsAttrib.relaxSettle(this.sync.intervalSec); })
      .catch(() => { /* tryAutoJoin 自吞错误，这里兜底防未处理拒绝 */ })
      .finally(() => { this.#autoJoinBusy = false; });
  }

  /**
   * 冷启动一次性装载上一轮已 fetch 到的分片（只读本地仓，不联网，百毫秒级）。
   * 首轮 poll 前 await：否则从启动到第一轮同步跑完（最长 intervalSec），美元、标定单价、
   * 多机机器数全按单机口径给，而他机数据其实就躺在本地 sync-repo 里——`--once` 尤其明显，
   * 它根本活不到第一轮同步完成（本次核算 fable 倍率时就被这个坑过一回）。
   */
  async #warmShards() {
    if (this.#shardsWarmed || !this.sync.enabled) return;
    this.#shardsWarmed = true;
    try {
      const shards = await this.sync.loadCachedShards();
      if (shards.length) this.#adoptShards(shards);
    } catch { /* 读缓存失败就等正常那一轮，不影响主流程 */ }
  }

  /** 外机分片到手：账本合并 + 挑出最新的账号额度快照。两处入口共用。 */
  #adoptShards(shards) {
    this.ledger.adoptForeignShards(shards);
    this.#adoptForeignLimits(shards);
  }

  /**
   * 他机分片里的账号级额度快照，取 capturedAt 最新的一份。
   * 只进不退：某一轮读不到分片（网络抖动、那台机器暂时离场）时留住上一份，
   * 否则界面会从「他机 2 分钟前的数」猛地退回本机那份陈旧锚点。龄期由显示面判。
   */
  #adoptForeignLimits(shards) {
    let best = null;
    for (const s of Array.isArray(shards) ? shards : []) {
      const l = s?.limits;
      if (!Array.isArray(l?.windows) || !l.windows.length || !(l.capturedAt > 0)) continue;
      if (!best || l.capturedAt > best.capturedAt) {
        best = {
          capturedAt: l.capturedAt, windows: l.windows,
          machineId: s.machineId ?? null, account: s.account ?? null,
          suspended: !!l.suspended, unmetered: !!l.unmetered, degraded: !!l.degraded,
        };
      }
    }
    if (best && !(this.foreignLimits?.capturedAt > best.capturedAt)) this.foreignLimits = best;
  }

  /**
   * 多机账本同步：按节流间隔触发，异步跑完把外机分片交给账本合并。
   * 失败不阻断主流程，只更新 sync 状态（payload 里可见）。
   *
   * 手里有账号额度快照（本机连着 Mirasim）时走 quotaIntervalSec 的快节奏：分片里那块
   * 额度是别的机器唯一的额度来源，压着十分钟不发，对面主行印的就是十分钟前的数。
   */
  #maybeSync() {
    if (!this.sync.enabled) { this.#maybeAutoJoin(Date.now() / 1000); return; }
    if (this.#syncBusy) return;
    const now = Date.now() / 1000;
    const limits = this.#shardLimits();
    const every = limits ? this.sync.quotaIntervalSec : this.sync.intervalSec;
    if (now - this.#syncKickedAt < every) return;
    this.#syncKickedAt = now;
    this.#syncBusy = true;
    const speed = this.#shardSpeed();
    // hub 通道另发一份账号额度：服务器上没有 Mirasim，这份数据只有跑着它的机器送得上去。
    // 与分片分开发——一台机器账本推失败不该连带把全账号的额度也丢了。
    if (limits) this.sync.pushLimits(limits).catch(() => { /* pushLimits 自吞错误 */ });
    this.sync.run(this.ledger, now, (speed || limits) ? { ...(speed ? { speed } : {}), ...(limits ? { limits } : {}) } : null)
      .then((r) => { if (r) this.#adoptShards(r.shards); })
      .catch(() => { /* run 自吞错误，这里兜底防未处理拒绝 */ })
      .finally(() => { this.#syncBusy = false; });
  }

  /**
   * 本机 Mirasim 没在跑时的额度补给：按 quotaIntervalSec 只读拉一次他机分片。
   *
   * 不这么做，额度要等下一轮完整同步（默认 10 分钟）才刷新，而这台机器此刻**只有**
   * 他机数据可用。只读省掉 push：本机没有 relay 在扣点，账本几乎不动，没什么可发的。
   * 本机连得上 Mirasim 时一次都不会发生（那时额度是自己实测的）。
   */
  #maybeQuotaPull(now) {
    if (!this.sync.enabled || this.#quotaPullBusy || this.#syncBusy) return;
    if (this.last && now - this.last.at <= RECKON_AFTER) return;
    if (now - this.#quotaPullAt < this.sync.quotaIntervalSec) return;
    this.#quotaPullAt = now;
    this.#quotaPullBusy = true;
    this.sync.refreshOnly(now)
      .then((shards) => { if (shards) this.#adoptShards(shards); })
      .catch(() => { /* refreshOnly 自吞错误，这里兜底防未处理拒绝 */ })
      .finally(() => { this.#quotaPullBusy = false; });
  }

  /**
   * 窗口期内的全家族明细：美元来自账本家族分桶，点数来自增量归因（都是实测口径）。
   * 模型档位窗（fable 等）本身就属于单一家族，官方点数即该家族点数，不出列表。
   */
  #familyBreakdown(start, now, group) {
    if (start == null || group) return null;
    const rows = this.ledger.familyIds().map((id) => {
      const usd = this.ledger.familySpent(start, now, id, { includeOpenMinute: true });
      const points = this.pointsAttrib.familyPoints(start, now, id);
      return { id, label: familyLabel(id), usd, ...(points >= 0.5 ? { points } : {}) };
    }).filter((r) => r.usd > 0.005 || r.points != null)
      .sort((a, b) => b.usd - a.usd);
    if (!rows.length) return null;
    const unattributed = this.pointsAttrib.unattributedPoints(start, now);
    return {
      families: rows,
      ...(unattributed >= 0.5 ? { familyPointsUnattributed: unattributed } : {}),
      // 归因自部署起才累积；起点晚于窗口起点时点数明细是部分的，展示需标注
      familyPointsPartial: !this.pointsAttrib.covers(start),
    };
  }

  /** speed 模块可选挂载：缺席或崩溃都不拖垮额度主线。 */
  async loadSpeed() {
    try {
      const mod = await import('./speed.mjs');
      if (mod?.SpeedStats) this.speed = new mod.SpeedStats();
    } catch { /* 缺席即无速度卡 */ }
  }

  #speedRefresh() { if (this.speed) try { this.speed.refresh(); } catch { /* 忽略 */ } }
  #speedReport() { if (!this.speed) return null; try { return this.speed.report(); } catch { return null; } }

  /**
   * 随分片发出去的速度快照：别人要看「这台机器跑得多快」，只有这台机器答得了
   * （账本分片是分钟桶，里面没有时长与 token 速率）。
   * 只带 rows 与样本数——在途条目（inflightSince）到对面早就结束了，带过去只会显示假在途。
   */
  #shardSpeed() {
    const r = this.#speedReport();
    if (!r?.rows?.length) return null;
    return { rows: r.rows, sampleTotal: r.sampleTotal ?? 0 };
  }

  /**
   * 随分片发出去的账号级额度快照：额度点是账号级的（同一个 userId 的所有设备共用一个池），
   * 哪台机器读到的都是同一份——所以只要有一台还连着 Mirasim，没连上的机器就不必退回
   * 自己那份陈旧锚点去猜满额（用户 2026-09-05：另一台在跑，总额度也要随时同步）。
   *
   * capturedAt 是**读到那一刻**，不是发分片这一刻：对面据此判龄期、与自己的锚点比新旧，
   * 差一步就会把陈旧数据当成新鲜的。太老的不发——那时对面自己的锚点多半还更近。
   */
  #shardLimits(nowSec = Date.now() / 1000) {
    if (!this.last?.limits?.windows?.length) return null;
    if (nowSec - this.last.at > ANCHOR_MAX_AGE) return null;
    const { windows, suspended, unmetered, degraded } = this.last.limits;
    return {
      capturedAt: this.last.at,
      windows: windows.map((w) => ({
        label: w.label, used: w.used, budget: w.budget, resetAt: w.resetAt,
        ...(w.modelScoped ? { modelScoped: true } : {}),
      })),
      ...(suspended ? { suspended: true } : {}),
      ...(unmetered ? { unmetered: true } : {}),
      ...(degraded ? { degraded: true } : {}),
    };
  }

  async #discoverChannelPort(processes) {
    const verify = async (p) => {
      const j = await getJSON(`http://127.0.0.1:${p}/api/health`);
      return j && j.name === 'mirasim' ? p : null;
    };
    const fromCmd = processes.map((p) => p.cmd.match(/--port[= ](\d+)/)).filter(Boolean).map((m) => Number(m[1]));
    for (const p of [...new Set([...fromCmd, CHANNEL_DEFAULT])]) if (await verify(p)) return p;
    for (let p = 4970; p <= 4980; p++) if (await verify(p)) return p;
    return null;
  }

  /**
   * 组装 /v1/limits 请求。两代认证并存（见 session-token.mjs 头注）：
   * 新版令牌并在 URL 路径里（此时不带 header——旧 header 令牌已失效，带上反而 401）；
   * 旧版走 x-api-key 头。
   */
  #limitsRequest(pair) {
    return {
      url: `http://127.0.0.1:${pair.port}${pair.path ?? ''}/v1/limits`,
      headers: !pair.path && pair.token ? { 'x-api-key': pair.token } : undefined,
    };
  }

  async #fetchLimits(pair, ms = 2500) {
    const { url, headers } = this.#limitsRequest(pair);
    return parseLimits(await getJSON(url, ms, headers));
  }

  /** 本进程若由 Mirasim 会话拉起，环境里就有现成的路由地址，零成本先试。 */
  #ownEnvPair() {
    const m = String(process.env.ANTHROPIC_BASE_URL || '')
      .match(/^http:\/\/127\.0\.0\.1:(\d+)(\/[^\s]*)?$/);
    if (!m) return null;
    return { port: Number(m[1]), path: m[2]?.replace(/\/+$/, '') || null, token: process.env.ANTHROPIC_AUTH_TOKEN || null };
  }

  /** 路由端口与令牌：显式参数 → 本进程环境 → PEB 自动发现 → 免认证（旧版）。 */
  async #discoverRouter(processes, channelPort) {
    const explicitPort = Number(this.opts.routerPort ?? 0);
    const explicitToken = this.opts.routerToken ?? null;

    if (this.cachedRouter) {
      if (await this.#fetchLimits(this.cachedRouter)) return this.cachedRouter;
      this.cachedRouter = null;
    }

    const pairs = [];
    if (explicitPort) pairs.push({ port: explicitPort, token: explicitToken });
    const own = this.#ownEnvPair();
    if (own) pairs.push(own);
    const discovered = explicitToken ? [] : await discoverSessionTokens();
    const byPort = new Map(discovered.map((d) => [d.port, d]));

    if (processes.length) {
      const byPid = await listeningPorts(processes.map((p) => p.pid));
      let ports = null;
      for (const [, list] of byPid) if (channelPort != null && list.includes(channelPort)) { ports = list; break; }
      if (!ports) ports = [...byPid.values()].flat();
      const ordered = [...new Set(ports)].sort((a, b) => (a === channelPort ? 1 : 0) - (b === channelPort ? 1 : 0));
      for (const p of ordered) {
        const d = byPort.get(p);
        pairs.push({ port: p, path: d?.path ?? null, token: explicitToken ?? d?.token ?? null });
      }
    }
    for (const d of discovered) if (!pairs.some((x) => x.port === d.port && (x.path ?? null) === (d.path ?? null))) pairs.push(d);

    for (const pair of pairs) {
      if (await this.#fetchLimits(pair)) {
        this.cachedRouter = pair;
        return pair;
      }
    }
    return null;
  }

  #recordTrail(limits, nowSec) {
    for (const w of limits.windows) {
      const list = this.pointsTrail[w.label] ?? (this.pointsTrail[w.label] = []);
      if (list.length && list[list.length - 1].at >= nowSec) continue;
      list.push({ at: nowSec, used: w.used, resetAt: w.resetAt });
      const cutoff = nowSec - 7200;
      while (list.length && list[0].at < cutoff) list.shift();
    }
  }

  #eta(w, nowSec) {
    const trail = (this.pointsTrail[w.label] ?? []).filter((p) => p.resetAt === w.resetAt && nowSec - p.at <= 3600);
    if (trail.length < 2) return null;
    const first = trail[0], last = trail[trail.length - 1];
    if (last.at - first.at < 180) return null;
    const rate = (last.used - first.used) / (last.at - first.at);
    if (rate <= 0) return null;
    return (w.budget - last.used) / rate;
  }

  /**
   * 耗尽预演素材。两个口径：
   * - avgSeconds：整窗均速（含空闲时间摊薄），「照这几天的节奏继续」还有多久打满；
   * - rate：活跃强度（每活跃小时消耗的点数），供「每天用 N 小时」推演。
   *   强度统一取近 3 天滚动，而非各自窗口期——5h 窗按窗口期采样会退化成
   *   「当前时段的瞬时速度」，样本又少又新（用户 2026-08-28 指出）。
   *   近 3 天不足半小时活跃时回退窗口期口径，basis 注明。
   */
  #exhaust(w, start, now, group) {
    if (start == null || !(w.used > 0)) return null;
    const elapsed = now - start;
    if (elapsed < 600) return null;
    const out = {};
    const avgRate = w.used / elapsed;
    if (avgRate > 0) out.avgSeconds = (w.budget - w.used) / avgRate;

    const HORIZON = 72 * 3600;
    const active3d = this.ledger.activeMinutes(now - HORIZON, now, { group }) / 60;
    const pts3d = this.calibrator.consumedPoints(w.label, now - HORIZON);
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const activeToday = this.ledger.activeMinutes(midnight.getTime() / 1000, now, { group }) / 60;

    if (active3d >= 0.5 && pts3d > 0) {
      out.rate = {
        pointsPerActiveHour: pts3d / active3d,
        activeHours3d: active3d, activeHoursToday: activeToday, basis: '3d',
      };
    } else {
      const activeWin = this.ledger.activeMinutes(start, now, { group }) / 60;
      if (activeWin >= 0.25) {
        out.rate = {
          pointsPerActiveHour: w.used / activeWin,
          activeHours3d: active3d, activeHoursToday: activeToday, basis: 'window',
        };
      }
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * 收下一份 /v1/limits 实测：本机自己读到的（poll）与服务端收到别的机器推来的（hub）
   * 走同一条路，口径不会长出第二份。
   * @param atSec 读到那一刻（不是收到这一刻）——标定/归因/锚点全按这个时刻对齐账本
   */
  ingestLimits(limits, atSec) {
    if (!limits?.windows?.length) return false;
    this.#recordTrail(limits, atSec);
    this.calibrator.record(limits.windows, atSec);
    this.pointsAttrib.record(limits.windows, atSec);
    this.anchors.update(limits.windows, atSec);
    this.ledger.adoptScopedGroups(
      limits.windows.filter((w) => w.modelScoped).map((w) => modelGroup(w.label)).filter(Boolean));
    this.last = { at: atSec, limits };
    this.everConnected = true;
    return true;
  }

  /** 一轮采集。返回是否拿到实测。 */
  async poll() {
    if (!this.opts.forceOffline) {
      const processes = await mirasimProcesses();
      const channelPort = await this.#discoverChannelPort(processes);
      const router = await this.#discoverRouter(processes, channelPort);
      const limits = router ? await this.#fetchLimits(router) : null;
      if (limits) this.ingestLimits(limits, Date.now() / 1000);
    }
    if (!this.opts.noLocal) this.ledger.refresh();
    this.#speedRefresh();   // 必须在 #maybeSync 之前：分片要带这一轮的速度，否则首轮发出去的是空速度
    await this.#warmShards();
    this.#maybeSync();   // 账本刷新完再发分片，coverage.toSec 才是「本次刷新完成时刻」
    this.#maybeQuotaPull(Date.now() / 1000);   // 本机没实测时，额度从还在跑的那台机器补
    this.pointsAttrib.settle(this.ledger, Date.now() / 1000);
    return !!this.last;
  }

  /** 契约 A 的 quota.json。只填有据可查的字段，控件对缺字段是容忍的。 */
  payload() {
    const now = Date.now() / 1000;
    const age = this.last ? now - this.last.at : Infinity;

    if (this.last && age <= RECKON_AFTER) return this.#measuredPayload(now, age);
    const remote = this.#remoteAnchors(now);
    if (remote) return this.#reckonedPayload(now, remote);
    if (this.anchors.usable) return this.#reckonedPayload(now);
    return this.#localPayload(now);
  }

  /**
   * 他机快照当锚点：只在它比本机锚点**更新**时才用。
   *
   * 两份锚点是同一个东西的两次读数（账号级额度），差别只在读的时刻与读的人，所以判据
   * 只有一条——谁更近。本机刚断线时自己的锚点更近，走本机那条；断了半天而他机一直在跑，
   * 走他机那条，连满额换了档位都跟着变。
   */
  #remoteAnchors(now) {
    const f = this.foreignLimits;
    if (!f || now - f.capturedAt >= ANCHOR_MAX_AGE) return null;
    if (this.anchors.usable && this.anchors.capturedAt >= f.capturedAt) return null;
    const anchors = anchorsFrom(f.windows, f.capturedAt);
    if (!anchors.length) return null;
    return { anchors, capturedAt: f.capturedAt, machineId: f.machineId, account: f.account, from: f };
  }

  #measuredPayload(now, age) {
    const stale = age > STALE_AFTER;
    const level = stale ? 'stale' : 'exact';
    const limits = this.last.limits;
    const coherence = evaluateCoherence(limits.windows, this.ledger, now, this.settings.groupPointCost);
    const rate = coherence.perPoint;

    let calibDropped = 0;
    const windows = limits.windows.map((w) => {
      const usedPercent = Math.min(100, w.used / w.budget * 100);
      const group = w.modelScoped ? modelGroup(w.label) : null;
      const dur = windowDuration(w.label);
      const start = dur ? w.resetAt - dur : null;
      const spent = start != null ? this.ledger.spent(start, now, { includeOpenMinute: true, group }) : 0;
      // 折算后支出：账本原值按档位倍率放大，就是「这些花费实际扣掉多少点」的美元等价。
      // 主行给的是**真实花费**（可与 Mirasim 逐笔核对，零推断），但它与满额不同口径——
      // 满额是点数口径。两个口径并排摆出来，用户才知道 $426 的用量为什么顶掉 $644 的额度。
      // （用户 2026-09-02：「7d 统计口径要把真实倍率后的花费算进去」。）
      const weighted = start != null
        ? (group ? spent * (this.settings.ratioOf(group) || 1)
          : weightedSpend(this.ledger, start, now, this.settings.groupPointCost).usd)
        : spent;
      // 满额 = 预算点 ÷ 100 ÷ 该档位倍率（2026-09-02 用户向官方确认后拍板）。
      // 档位窗除以倍率，给的是「拿这个档位真能花掉多少 API 用量」——fable 每花 1 美元扣
      // 2 点，296800 点的子上限只兑得出 $1484。用户 2026-09-02 在两个口径里选了这个：
      // 这张卡整块活在「真实 fable 美元」这把尺上，能直接跟主行的账本花费比。
      const groupRatio = group ? this.settings.ratioOf(group) : 1;
      const { fullUSD, confidence, sampleCount, dropped, basis, conservativeUSD } =
        this.#fullOf(w.label, w.budget, group, this.#officialFull(w.budget, groupRatio));
      calibDropped += dropped;
      const pace = start != null && dur ? Math.min(100, Math.max(0, (now - start) / dur * 100)) : null;
      const eta = this.#eta(w, now);
      const exhaust = this.#exhaust(w, start, now, group);
      const breakdown = this.#familyBreakdown(start, now, group);
      return {
        label: w.label, usedPercent, inferred: false, confidence, sampleCount,
        spentUSD: spent,
        ...(!group && spent > 0 && Math.abs(weighted - spent) / spent > 0.005
          ? { weightedSpentUSD: weighted } : {}),
        ...(breakdown ?? {}),
        ...(dur != null ? { durationSeconds: dur } : {}),

        ...(exhaust ? { exhaust } : {}),
        ...(fullUSD != null ? {
          fullUSD,
          ...(basis ? { fullUSDBasis: basis } : {}),
          // 分段单价中位数：抗污染但系统性保守，只作次要参考（界面放在 tooltip 里）
          ...(conservativeUSD != null && Math.abs(conservativeUSD - fullUSD) / fullUSD > 0.05
            ? { conservativeUSD } : {}),
          scaledSpentUSD: fullUSD * usedPercent / 100,
          remainingUSD: Math.max(0, fullUSD * (100 - usedPercent) / 100),
        } : {}),
        points: { used: w.used, budget: w.budget },
        resetAt: w.resetAt,
        ...(pace != null ? { pacePercent: pace, paceDelta: usedPercent - pace } : {}),
        ...(eta != null ? { etaSeconds: eta } : {}),
        ...(group ? { modelGroup: group } : {}),
      };
    });

    const notice = limits.suspended ? '账号被暂停，额度数字仅供参考'
      : limits.unmetered ? '账号不计量，额度上限不适用'
      : limits.degraded ? '上游降级运行中' : null;

    const out = this.#base(level, this.last.at, windows);
    out.unitPriceUSD = OFFICIAL_PER_POINT;
    if (rate != null) {
      out.ledgerPerPoint = rate;
      // 公式素材：单价 = 基准窗账本支出 ÷ 同期已用点数；spread 是跨窗交叉校验的离散倍数
      out.unitPriceCalc = {
        usd: coherence.basis.usd, points: coherence.basis.points, label: coherence.basis.label,
        ...(coherence.basis.adjustments?.length
          ? { rawUSD: coherence.basis.rawUSD, adjustments: coherence.basis.adjustments } : {}),
      };
      if (coherence.spread != null) out.unitPriceSpread = coherence.spread;
    } else { const n = coherenceNotice(coherence); if (n) out.unitPriceNotice = n; }
    const pc = this.#pointCost(limits.windows, now);
    if (pc) out.pointCost = pc;
    if (notice) out.accountNotice = notice;
    if (calibDropped > 0) out.calibDropped = calibDropped;
    if (stale) out.detail = `接口已 ${Math.round(age / 60)} 分钟未回传，显示最后一次实测值`;
    return out;
  }

  /**
   * 锚点推算：窗口边界滚动 + 账本。同窗口期内以锚点百分比为基线（更准），滚动后纯账本口径。
   * @param remote 他机送来的账号额度快照当锚点时传入（见 #remoteAnchors）；否则用本机锚点
   */
  #reckonedPayload(now, remote = null) {
    const src = remote ?? { anchors: this.anchors.anchors, capturedAt: this.anchors.capturedAt };
    const windows = src.anchors.map((a) => {
      const rolled = AnchorStore.rollWindow(a, now);
      if (!rolled) return null;
      const group = a.modelScoped ? modelGroup(a.label) : null;
      // 锚点带着官方预算点，所以 Mirasim 不在跑时满额照样精确（旧代码在这里退回中位数，
      // 与实测路径两套算法，用户 2026-09-02 截图里 7d 报 $2837 而非 $5600 就是这里）。
      const est = this.calibrator.estimate(a.label, this.ledger, a.budget, group);
      const fullUSD = this.#officialFull(a.budget, group ? this.settings.ratioOf(group) : 1)
        ?? est?.fullUSD ?? null;
      let usedPercent;
      if (!rolled.rolled) {
        const spentSince = this.ledger.spent(a.capturedAt, now, { includeOpenMinute: true, group });
        usedPercent = a.usedPercent + (fullUSD ? spentSince / fullUSD * 100 : 0);
      } else {
        const spent = this.ledger.spent(rolled.start, now, { includeOpenMinute: true, group });
        usedPercent = fullUSD ? Math.min(100, spent / fullUSD * 100) : 0;
      }
      usedPercent = Math.min(100, usedPercent);
      const spentUSD = this.ledger.spent(rolled.start, now, { includeOpenMinute: true, group });
      const dur = a.duration;
      const pace = Math.min(100, Math.max(0, (now - rolled.start) / dur * 100));
      const breakdown = this.#familyBreakdown(rolled.start, now, group);
      return {
        label: a.label, usedPercent, inferred: true, durationSeconds: a.duration,
        confidence: est?.confidence ?? 'none', sampleCount: est?.observations ?? 0,
        spentUSD,
        ...(breakdown ?? {}),
        ...(fullUSD != null ? {
          fullUSD,
          scaledSpentUSD: fullUSD * usedPercent / 100,
          remainingUSD: Math.max(0, fullUSD * (100 - usedPercent) / 100),
        } : {}),
        resetAt: rolled.end,
        pacePercent: pace, paceDelta: usedPercent - pace,
        ...(group ? { modelGroup: group } : {}),
      };
    }).filter(Boolean);

    const ageMin = Math.round((now - src.capturedAt) / 60);
    const ageText = ageMin >= 60 ? `${(ageMin / 60).toFixed(1)} 小时` : `${ageMin} 分钟`;
    const out = this.#base('reckoned', src.capturedAt, windows);
    // 锚点自带 used/budget/modelScoped，实测倍率按采集时刻算（那一刻账本与官方计数器同期）
    const pcR = this.#pointCost(src.anchors, src.capturedAt);
    if (pcR) out.pointCost = pcR;
    out.measured = false;
    if (remote) {
      const who = remote.account && remote.account !== remote.machineId
        ? `${remote.account}·${remote.machineId}` : (remote.machineId ?? '另一台机器');
      // 他机读到的是**账号级**额度，他人占用已经计在里面了——这跟本机锚点那条不是一回事，
      // 文案必须分开写，否则用户会以为这个数照样看不见别人。
      out.detail = `本机 Mirasim 未运行，按「${who}」${ageText}前读到的账号额度推算；他人占用已计到那一刻`;
      out.reckonFrom = {
        machineId: remote.machineId, account: remote.account,
        capturedAt: remote.capturedAt, ageSeconds: now - remote.capturedAt,
      };
      const n = remote.from.suspended ? '账号被暂停，额度数字仅供参考'
        : remote.from.unmetered ? '账号不计量，额度上限不适用'
        : remote.from.degraded ? '上游降级运行中' : null;
      if (n) out.accountNotice = n;
    } else {
      out.detail = `Mirasim 未运行，按 ${ageText}前的窗口锚点推算；他人占用不可见`;
    }
    return out;
  }

  /** 最后一级：滚动窗口报本机支出。 */
  #localPayload(now) {
    const windows = [['5h', 5 * 3600], ['7d', 7 * 86400]].map(([label, dur]) => {
      const spent = this.ledger.spent(now - dur, now, { includeOpenMinute: true });
      const est = this.calibrator.estimate(label, this.ledger, null, null, this.settings.groupPointCost);
      const breakdown = this.#familyBreakdown(now - dur, now, null);
      return {
        label, inferred: true,
        usedPercent: est?.fullUSD ? Math.min(100, spent / est.fullUSD * 100) : 0,
        confidence: est?.confidence ?? 'none', sampleCount: est?.observations ?? 0,
        spentUSD: spent,
        ...(breakdown ?? {}),
        ...(est?.fullUSD ? { fullUSD: est.fullUSD } : {}),
      };
    });
    const out = this.#base('local', now, windows);
    const pcL = this.#pointCost(this.anchors.anchors, null);
    if (pcL) out.pointCost = pcL;
    out.measured = false;
    out.detail = this.everConnected
      ? '接口不可达且无窗口锚点，仅按本机滚动窗口统计支出'
      : '未取到 Mirasim 的额度接口：确认 Mirasim 正在运行（首次连接需要它在线一次）。';
    return out;
  }

  /**
   * 「今天」摘要（自然日 0 点起）：官方窗口没有日口径，这里用官方点数增量逐段累加补上。
   * 点数取非档位、周期最长的窗（7d）——重置最少，consumedPoints 的停机补账最完整；
   * 点数是账号级（含他机），美元是账本口径（未启用多机同步时即本机；启用后含已同步的
   * 外机分片，与点数的差距只剩同步时滞），展示时分开标。
   */
  #todaySummary(now) {
    const midnight = new Date(now * 1000);
    midnight.setHours(0, 0, 0, 0);
    const from = midnight.getTime() / 1000;
    const base = Object.keys(this.calibrator.points).filter((l) => !modelGroup(l))
      .sort((a, b) => (windowDuration(b) ?? 0) - (windowDuration(a) ?? 0))[0];
    const points = base ? this.calibrator.consumedPoints(base, from) : 0;
    const usd = this.ledger.spent(from, now, { includeOpenMinute: true });
    const families = this.ledger.familyIds().map((id) => {
      const fUsd = this.ledger.familySpent(from, now, id, { includeOpenMinute: true });
      const fPts = this.pointsAttrib.familyPoints(from, now, id);
      return { id, label: familyLabel(id), usd: fUsd, ...(fPts >= 0.5 ? { points: fPts } : {}) };
    }).filter((r) => r.usd > 0.005 || r.points != null).sort((a, b) => b.usd - a.usd);
    const unattributed = this.pointsAttrib.unattributedPoints(from, now);
    return {
      from, points, usd, families,
      ...(unattributed >= 0.5 ? { unattributedPoints: unattributed } : {}),
    };
  }

  /**
   * 满额取「总额比值」口径：整窗支出 ÷ 整窗点数 × 预算点（2026-09-02 用户拍板）。
   *
   * 原来优先用回归标定（分段单价的加权中位数）。两者同时在跑，本机实测差 36%：
   * 中位数 $4103、总额比值 $5582，而官方宣称 5600——用户要的是界面数字能直接与官方对账，
   * 所以主口径改为总额比值。中位数抗污染更强，退居备用：总额比值给不出（点数样本太少、
   * 或跨窗离散判不自洽）时才用它，此时宁可保守也不要没有数。
   * 回归标定的观测数仍然照常汇报——它是「这个数有多少实测撑着」的唯一来源。
   */
  /**
   * 档位倍率：配置值与实测值（各出自一个独立的官方计数器）一起给界面，用户能自己对表。
   * 三条 payload 路径都要给——这是个**设置**，Mirasim 没在跑时用户照样该能看见和改。
   * （用户 2026-09-02 指出：没连上时整张配置卡消失，看着像「最近没用 fable 就不显示倍率」。）
   * 实测值要官方计数器与账本对齐的那一刻：实测态用 now，推算态用锚点采集时刻——
   * 拿陈旧的点数配到当下的账本会算出一个假倍率，宁可只给设置值。
   * @param windows 有 used/budget/modelScoped 的窗口数组；给不出就传 null（只回设置值）
   */
  #pointCost(windows, atSec) {
    const groups = [...new Set((windows ?? []).filter((w) => w.modelScoped)
      .map((w) => modelGroup(w.label)).filter(Boolean))];
    if (!groups.length) return null;
    return groups.map((g) => {
      const m = atSec != null ? measureGroupRatio(windows, this.ledger, atSec, g) : null;
      return { group: g, ratio: this.settings.ratioOf(g), ...(m ? { measured: m.measured } : {}) };
    });
  }

  /**
   * 7 天里每台机器各花了多少，外加一条「未接入」。
   * 每台机器 = 它自己的账本按倍率折算 ÷ 0.01（折算后才与官方点数同尺）；
   * 未接入 = 官方已用点 − 各机之和。
   * 这条残差同时装着两样东西：真的没跑 MiraQuota 的人，和各机账本自己漏记的部分
   * （未归因点数、relay 未回填、分片延迟，本机实测约 3.5%）。界面必须说清，
   * 否则用户会把「我们的账本不准」读成「别人用了这么多」。
   */
  #machineUsage(windows) {
    const w = windows.find((x) => x.label === '7d') ?? windows.find((x) => !x.modelGroup);
    if (!w?.durationSeconds || !w.resetAt) return null;
    const now = Date.now() / 1000;
    const ratio = this.settings.ratioOf('fable');
    const rows = this.ledger
      .perMachineSpent(w.resetAt - w.durationSeconds, now, {
        group: 'fable', self: { machineId: this.sync.machineId, ...this.sync.identity },
      })
      .map((r) => {
        const usd = r.usd + (ratio > 0 ? (ratio - 1) * r.groupUSD : 0);
        return { id: r.machineId, key: r.installId ?? r.machineId, account: r.account, self: r.self, usd, points: usd / OFFICIAL_PER_POINT };
      })
      .sort((a, b) => b.points - a.points);
    const known = rows.reduce((a, b) => a + b.points, 0);
    const official = w.points?.used ?? null;
    // 没价的调用：点扣了、美元算不出，只能给 token。它们也落在残差里，但至少有名字。
    const unpriced = this.ledger.unpricedUsage(w.resetAt - w.durationSeconds, now);
    return {
      usage: {
        label: w.label, machines: rows,
        ...(unpriced.length ? { unpriced } : {}),
        ...(official != null ? {
          officialPoints: official,
          // 残差＝「账本没同步上来的机器」：没跑 MiraQuota 的人、关了同步的机器、分片过期的机器，
          // 外加各机账本自己的时差漏记（用户 2026-09-02 拍板归成一类）。
          unattributedPoints: Math.max(0, official - known),
          unattributedUSD: Math.max(0, official - known) * OFFICIAL_PER_POINT,
        } : {}),
      },
    };
  }

  /** 官方满额：预算点 ÷ 100 ÷ 档位倍率。预算点缺席（纯本机口径）时返回 null。 */
  #officialFull(budget, ratio) {
    if (!(budget > 0) || !(ratio > 0)) return null;
    return budget * OFFICIAL_PER_POINT / ratio;
  }

  #fullOf(label, budget, group, ratioFull) {
    const est = this.calibrator.estimate(label, this.ledger, budget, group, this.settings.groupPointCost);
    const dropped = est?.foreignDropped ?? 0;
    if (ratioFull != null) {
      return {
        fullUSD: ratioFull, basis: 'official', conservativeUSD: est?.fullUSD ?? null,
        confidence: est?.confidence ?? 'low', sampleCount: est?.observations ?? 0, dropped,
      };
    }
    // 官方预算点缺席（纯本机滚动窗口）才退回中位数：宁可保守，不要没有数
    if (est) {
      return {
        fullUSD: est.fullUSD, basis: 'median', conservativeUSD: null,
        confidence: est.confidence, sampleCount: est.observations, dropped,
      };
    }
    return { fullUSD: null, confidence: 'none', sampleCount: 0, dropped };
  }

  #base(level, capturedAt, windows) {
    return {
      state: level,
      stateLabel: LEVELS[level],
      measured: level === 'exact' || level === 'stale',
      capturedAt,
      mode: '-', host: '-', relayStatus: '-',
      pricing: this.pricing.source,
      buckets: this.ledger.bucketCount,
      windows,
      today: this.#todaySummary(Date.now() / 1000),
      speed: this.#speedReport(),
      // 无同步配置时不出现该字段，显示面据此不画任何新 UI（硬性验收项）。
      ...(this.sync.enabled ? { sync: { ...this.sync.status(), ...this.#machineUsage(windows) } } : {}),
      // 没同步时给登录入口（收件口地址可改）：没有 GitHub 的人从这里进（2026-09-02）
      ...(!this.sync.enabled ? { syncLogin: { inbox: DEFAULT_INBOX } } : {}),
      ...(this.#roster() ?? {}),
    };
  }

  /**
   * 多机页登录框 → 收件口。成功后立刻跑一轮同步并放宽归因静置，用户不用等 10 分钟才看到机器。
   * @returns LedgerSync.login 的结果
   */
  async loginSync(opts) {
    const r = await this.sync.login(opts);
    if (r.ok) {
      this.pointsAttrib.relaxSettle(this.sync.intervalSec);
      this.#shardsWarmed = false;
      this.#syncKickedAt = 0;
      this.#maybeSync(Date.now() / 1000);
    }
    return r;
  }

  #rosterAt = 0; #rosterCache = null;
  /** 已启用模型对表价目表；文件小，一分钟读一次够了。 */
  #roster() {
    const now = Date.now();
    if (now - this.#rosterAt > 60_000) { this.#rosterCache = readEnabledModels(this.pricing); this.#rosterAt = now; }
    return this.#rosterCache ? { roster: this.#rosterCache } : null;
  }
}
