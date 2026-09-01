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

import { Pricing } from './pricing.mjs';
import { CostLedger } from './ledger.mjs';
import { LedgerSync } from './ledger-sync.mjs';
import { PointsAttributor } from './points-attrib.mjs';
import { familyLabel } from './model-families.mjs';
import { Calibrator } from './calibrator.mjs';
import { evaluateCoherence, coherenceNotice } from './coherence.mjs';
import { discoverSessionTokens } from './session-token.mjs';
import { windowDuration, modelGroup } from './windows.mjs';
import { AnchorStore } from './anchors.mjs';

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
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.pricing = new Pricing();
    this.ledger = new CostLedger(this.pricing);
    this.pointsAttrib = new PointsAttributor();
    this.calibrator = new Calibrator();
    this.anchors = new AnchorStore();
    this.sync = new LedgerSync(opts.syncOpts);
    // 同步启用时放宽归因静置：外机支出要等它下一轮发布分片才可见（见 points-attrib.mjs）。
    if (this.sync.enabled) this.pointsAttrib.relaxSettle(this.sync.intervalSec);
    this.speed = null;
    this.cachedRouter = null;
    this.last = null;           // { at, limits }
    this.pointsTrail = {};
    this.everConnected = false;
  }

  #syncBusy = false;
  #syncKickedAt = 0;
  #autoJoinBusy = false;
  #autoJoinAt = 0;

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
   * 多机账本同步：按 intervalSec 节流触发，异步跑完把外机分片交给账本合并。
   * 失败不阻断主流程，只更新 sync 状态（payload 里可见）。
   */
  #maybeSync() {
    if (!this.sync.enabled) { this.#maybeAutoJoin(Date.now() / 1000); return; }
    if (this.#syncBusy) return;
    const now = Date.now() / 1000;
    if (now - this.#syncKickedAt < this.sync.intervalSec) return;
    this.#syncKickedAt = now;
    this.#syncBusy = true;
    this.sync.run(this.ledger, now)
      .then((r) => { if (r) this.ledger.adoptForeignShards(r.shards); })
      .catch(() => { /* run 自吞错误，这里兜底防未处理拒绝 */ })
      .finally(() => { this.#syncBusy = false; });
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

  /** 一轮采集。返回是否拿到实测。 */
  async poll() {
    if (!this.opts.forceOffline) {
      const processes = await mirasimProcesses();
      const channelPort = await this.#discoverChannelPort(processes);
      const router = await this.#discoverRouter(processes, channelPort);
      const limits = router ? await this.#fetchLimits(router) : null;
      if (limits) {
        const nowSec = Date.now() / 1000;
        this.#recordTrail(limits, nowSec);
        this.calibrator.record(limits.windows, nowSec);
        this.pointsAttrib.record(limits.windows, nowSec);
        this.anchors.update(limits.windows, nowSec);
        this.ledger.adoptScopedGroups(
          limits.windows.filter((w) => w.modelScoped).map((w) => modelGroup(w.label)).filter(Boolean));
        this.last = { at: nowSec, limits };
        this.everConnected = true;
      }
    }
    this.ledger.refresh();
    this.#maybeSync();   // 账本刷新完再发分片，coverage.toSec 才是「本次刷新完成时刻」
    this.pointsAttrib.settle(this.ledger, Date.now() / 1000);
    this.#speedRefresh();
    return !!this.last;
  }

  /** 契约 A 的 quota.json。只填有据可查的字段，控件对缺字段是容忍的。 */
  payload() {
    const now = Date.now() / 1000;
    const age = this.last ? now - this.last.at : Infinity;

    if (this.last && age <= RECKON_AFTER) return this.#measuredPayload(now, age);
    if (this.anchors.usable) return this.#reckonedPayload(now);
    return this.#localPayload(now);
  }

  #measuredPayload(now, age) {
    const stale = age > STALE_AFTER;
    const level = stale ? 'stale' : 'exact';
    const limits = this.last.limits;
    const coherence = evaluateCoherence(limits.windows, this.ledger, now);
    const rate = coherence.perPoint;

    let calibDropped = 0;
    const windows = limits.windows.map((w) => {
      const usedPercent = Math.min(100, w.used / w.budget * 100);
      const group = w.modelScoped ? modelGroup(w.label) : null;
      const dur = windowDuration(w.label);
      const start = dur ? w.resetAt - dur : null;
      const spent = start != null ? this.ledger.spent(start, now, { includeOpenMinute: true, group }) : 0;
      const { fullUSD, confidence, sampleCount, dropped } = this.#fullOf(w.label, w.budget, group, rate);
      calibDropped += dropped;
      // 第二个口径：直接用官方百分比反推满额（本机账本$ ÷ 官方已用点数 × 预算点）。
      // 与上面的回归标定互为交叉验证——两者接近说明账本与点数自洽。
      // modelScoped 窗口的分桶自档位声明起才累积，此口径会系统性偏低，故标注出来。
      const fullUSDOfficial = spent > 0 && w.used > 0 ? spent / w.used * w.budget : null;
      const pace = start != null && dur ? Math.min(100, Math.max(0, (now - start) / dur * 100)) : null;
      const eta = this.#eta(w, now);
      const exhaust = this.#exhaust(w, start, now, group);
      const breakdown = this.#familyBreakdown(start, now, group);
      return {
        label: w.label, usedPercent, inferred: false, confidence, sampleCount,
        spentUSD: spent,
        ...(breakdown ?? {}),
        ...(dur != null ? { durationSeconds: dur } : {}),
        ...(fullUSDOfficial != null ? { fullUSDOfficial, officialBiasedLow: !!group } : {}),
        ...(exhaust ? { exhaust } : {}),
        ...(fullUSD != null ? {
          fullUSD,
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
    if (rate != null) {
      out.unitPriceUSD = rate;
      // 公式素材：单价 = 基准窗账本支出 ÷ 同期已用点数；spread 是跨窗交叉校验的离散倍数
      out.unitPriceCalc = { usd: coherence.basis.usd, points: coherence.basis.points, label: coherence.basis.label };
      if (coherence.spread != null) out.unitPriceSpread = coherence.spread;
    } else { const n = coherenceNotice(coherence); if (n) out.unitPriceNotice = n; }
    if (notice) out.accountNotice = notice;
    if (calibDropped > 0) out.calibDropped = calibDropped;
    if (stale) out.detail = `接口已 ${Math.round(age / 60)} 分钟未回传，显示最后一次实测值`;
    return out;
  }

  /** 锚点推算：窗口边界滚动 + 本机账本。同窗口期内以锚点百分比为基线（更准），滚动后纯本机口径。 */
  #reckonedPayload(now) {
    const windows = this.anchors.anchors.map((a) => {
      const rolled = AnchorStore.rollWindow(a, now);
      if (!rolled) return null;
      const group = a.modelScoped ? modelGroup(a.label) : null;
      const est = this.calibrator.estimate(a.label, this.ledger, a.budget, group);
      const fullUSD = est?.fullUSD ?? null;
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
        label: a.label, usedPercent, inferred: true,
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

    const ageMin = Math.round((now - this.anchors.capturedAt) / 60);
    const ageText = ageMin >= 60 ? `${(ageMin / 60).toFixed(1)} 小时` : `${ageMin} 分钟`;
    const out = this.#base('reckoned', this.anchors.capturedAt, windows);
    out.measured = false;
    out.detail = `Mirasim 未运行，按 ${ageText}前的窗口锚点推算；他人占用不可见，实际用量可能更高`;
    return out;
  }

  /** 最后一级：滚动窗口报本机支出。 */
  #localPayload(now) {
    const windows = [['5h', 5 * 3600], ['7d', 7 * 86400]].map(([label, dur]) => {
      const spent = this.ledger.spent(now - dur, now, { includeOpenMinute: true });
      const est = this.calibrator.estimate(label, this.ledger);
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

  #fullOf(label, budget, group, rate) {
    const est = this.calibrator.estimate(label, this.ledger, budget, group);
    const dropped = est?.foreignDropped ?? 0;
    if (est && (est.confidence === 'high' || est.confidence === 'medium')) {
      return { fullUSD: est.fullUSD, confidence: est.confidence, sampleCount: est.observations, dropped };
    }
    if (rate != null) return { fullUSD: rate * budget, confidence: 'low', sampleCount: est?.observations ?? 0, dropped };
    if (est) return { fullUSD: est.fullUSD, confidence: est.confidence, sampleCount: est.observations, dropped };
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
      ...(this.sync.enabled ? { sync: this.sync.status() } : {}),
    };
  }
}
