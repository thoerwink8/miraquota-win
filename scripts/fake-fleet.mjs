#!/usr/bin/env node
/**
 * 本地假 fleet-dao：只实现 MiraQuota 要调的那一个接口（GET /api/quota），后端上线之前用它测。
 *
 *   node scripts/fake-fleet.mjs [--port 4960] [--token <令牌>]
 *
 * 起来后在面板「账号池」页填 http://127.0.0.1:<端口> 和打印出来的令牌。数据是造的（脱敏），
 * 每个池的形状照 fleet-dao `quotaTable()` 的一行（QuotaTablePool / QuotaTableWindow，时间转 ISO）：
 * 两个 Claude 组织、Mirasim、Cursor、Grok、Jev。故意带上客户端不看的列（billing、inFlight、
 * remainingRatio……），证明多出来的字段不碍事。
 * 测试（test/fleet-source.test.mjs）用的也是这一份：startFakeFleet() 与 sampleQuota()。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const iso = (sec) => new Date(sec * 1000).toISOString();

/**
 * 一份照约定造的回包，时间都相对 nowSec。故意各带一种要画出来的情形：
 * 拼车组织这次没读成（显示的是 3 小时前那次、带失败原因）、Cursor 的 api 窗上游这次没报（staleSince）、
 * Jev 是估算、有一格单位是 tokens。
 */
export function sampleQuota(nowSec = Math.floor(Date.now() / 1000)) {
  const at = nowSec - 180;                      // 最近一轮读取在 3 分钟前
  const win = (w) => ({
    scope: null, utilization: null, used: null, limit: null, resetsAt: null, upstreamStatus: null, statusRaw: null,
    reading: 'measured', readAt: iso(at), staleSince: null,
    remainingRatio: null, resetsInMs: null, state: 'ok',          // quotaTable 有、客户端不看
    ...w,
  });
  const pool = (p) => ({
    billing: 'subscription', channelEnabled: true, maxConcurrency: 2, inFlight: 0, scopeModels: null,   // 客户端不看
    expiresAt: null, lastReadOkAt: iso(at), dataAt: iso(at), neverRead: false, readOverdue: false,
    ...p,
  });
  return {
    schema: 1,
    asOf: iso(nowSec),
    staleAfterMinutes: 30,
    pools: [
      pool({
        poolId: 'claude-solo', channelId: 'claude', channelName: 'Claude 订阅',
        expiresAt: iso(nowSec + 12 * 86400),
        windows: [
          win({ label: 'session', window: '5h', utilization: 0.16, used: 16, limit: 100, unit: 'percent', resetsAt: iso(nowSec + 3 * 3600 + 120), upstreamStatus: 'allowed', source: 'claude-usage' }),
          win({ label: 'weekly_all', window: '7d', utilization: 0.24, used: 24, limit: 100, unit: 'percent', resetsAt: iso(nowSec + 2.6 * 86400), upstreamStatus: 'allowed', source: 'claude-usage' }),
        ],
      }),
      pool({
        poolId: 'claude-carpool', channelId: 'claude', channelName: 'Claude 订阅',
        lastReadOkAt: iso(nowSec - 3 * 3600), dataAt: iso(nowSec - 3 * 3600), readOverdue: true,
        lastError: { code: 'not_current', message: '这台机器当前挂的不是这个组织，没读', at: iso(at) },
        windows: [
          win({ label: 'weekly_all', window: '7d', utilization: 0.26, used: 26, limit: 100, unit: 'percent', resetsAt: iso(nowSec + 2.7 * 86400), source: 'claude-usage', readAt: iso(nowSec - 3 * 3600), state: 'stale' }),
        ],
      }),
      pool({
        poolId: 'mirasim', channelId: 'mirasim', channelName: 'Mirasim 中转',
        windows: [
          win({ label: '5h', window: '5h', utilization: 0.0412, used: 5_913, limit: 143_528, unit: 'points', resetsAt: iso(nowSec + 4 * 3600), source: 'mirasim-relay' }),
          win({ label: '7d', window: '7d', utilization: 0.557, used: 285_511, limit: 512_600, unit: 'points', resetsAt: iso(nowSec + 4.2 * 86400), source: 'mirasim-relay' }),
          win({ label: '7d_claude', window: '7d_model', scope: 'claude', utilization: 0.522, used: 267_577, limit: 512_600, unit: 'points', resetsAt: iso(nowSec + 4.2 * 86400), source: 'mirasim-relay' }),
          win({ label: '7d_fable', window: '7d_model', scope: 'fable', utilization: 0.332, used: 90_243, limit: 271_678, unit: 'points', resetsAt: iso(nowSec + 4.2 * 86400), source: 'mirasim-relay' }),
        ],
      }),
      pool({
        poolId: 'cursor', channelId: 'cursor', channelName: 'Cursor', expiresAt: iso(nowSec + 9 * 86400),
        windows: [
          win({ label: 'plan_usd', window: 'month_usd', utilization: 0.557, used: 222.91, limit: 400, unit: 'usd', resetsAt: iso(nowSec + 9 * 86400), source: 'cursor-dashboard' }),
          win({ label: 'auto_percent', window: 'other', scope: 'auto', utilization: 0.074, used: 7.4, limit: 100, unit: 'percent', source: 'cursor-dashboard' }),
          win({ label: 'api_percent', window: 'other', scope: 'api', utilization: 0, used: 0, limit: 100, unit: 'percent', source: 'cursor-dashboard', readAt: iso(nowSec - 3600), staleSince: iso(nowSec - 1800), state: 'stale' }),
        ],
      }),
      pool({
        poolId: 'grok', channelId: 'grok', channelName: 'Grok',
        windows: [
          win({ label: 'weekly', window: '7d', utilization: 0.47, used: 47, limit: 100, unit: 'percent', resetsAt: iso(nowSec + 3.5 * 86400), upstreamStatus: 'allowed', source: 'grok-billing' }),
        ],
      }),
      pool({
        poolId: 'jev', channelId: 'jev', channelName: 'Jev 判断题', billing: 'metered',
        windows: [
          win({ label: 'month_usd', window: 'month_usd', utilization: 0.06, used: 0.018, limit: 0.3, unit: 'usd', resetsAt: iso(nowSec + 9 * 86400), reading: 'estimated', source: 'estimate' }),
          win({ label: 'daily_tokens', window: 'other', utilization: 0.062, used: 12_400, limit: 200_000, unit: 'tokens', resetsAt: iso(nowSec + 8 * 3600), reading: 'estimated', source: 'estimate' }),
        ],
      }),
    ],
  };
}

/**
 * 起一个假后端。只认 GET /api/quota + 对的 Bearer 令牌，其余照约定回错。
 * @param opts.token   要求的令牌（默认随机）
 * @param opts.body    回包：对象，或 (nowSec) => 对象；默认 sampleQuota
 * @param opts.status  强行回这个状态码（测 401/403/5xx 用），配 opts.error 当错误体
 * @param opts.delayMs 故意慢（测超时）
 * @param opts.raw     原样回这串文本（测「回包不是 JSON」）
 * @returns { url, token, requests, set(patch), close }
 */
export function startFakeFleet({ token = randomBytes(16).toString('hex'), port = 0, t = null, ...rest } = {}) {
  const state = { body: sampleQuota, status: null, error: null, delayMs: 0, raw: null, ...rest };
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (req.method !== 'GET' || req.url !== '/api/quota') return send(404, { error: { code: 'not_found', message: '没有这个接口' } });
    const auth = String(req.headers.authorization ?? '');
    if (auth !== `Bearer ${token}`) return send(401, { error: { code: 'unauthorized', message: '令牌不对或已吊销' } });
    if (state.status) return send(state.status, state.error ?? { error: { code: 'internal', message: '后端出错' } });
    if (state.raw != null) return send(200, state.raw);
    const body = typeof state.body === 'function' ? state.body(Math.floor(Date.now() / 1000)) : state.body;
    return send(200, body);
  });
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  if (typeof t?.after === 'function') t.after(close);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({
      url: `http://127.0.0.1:${server.address().port}`, token, requests,
      set: (patch) => Object.assign(state, patch),
      close,
    });
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  // 默认端口避开 feed（4988–4995）与 Mirasim 通道（4970–4980），不然在跑着面板的机器上起不来
  const fake = await startFakeFleet({ port: Number(opt('port', 4960)), ...(opt('token') ? { token: opt('token') } : {}) });
  console.log(`假 fleet-dao 起来了：${fake.url}/api/quota`);
  console.log(`在面板「账号池」页填：地址 ${fake.url}　令牌 ${fake.token}`);
  process.on('SIGINT', () => fake.close().then(() => process.exit(0)));
}
