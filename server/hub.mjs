/**
 * MiraQuota Hub：账本与账号额度的唯一真相，跑在一台各机都连得上的服务器上。
 *
 * 为什么要有它（用户 2026-09-05 拍板）：从前每台机器各自把分片推进一个私有 git 仓 /
 * Cloudflare Worker，再各自把全部分片拉回来自己合并、自己标定、自己算口径。三个后果——
 * 口径每台算一遍（版本一错就是两个数）、实时性卡在 git 节流上（10 分钟）、
 * 新机器要 GitHub 凭据或邀请码才进得来。
 *
 * 换成 hub 之后：机器只管把自己那份推上来，服务器合并 + 算好整份 payload，面板拿现成的画。
 * 客户端填一个地址就完事，不区分机器。
 *
 * 刻意不做的事：
 *  - 不读任何本机会话记录。这台机器上没有别人的 transcript，账本全部来自推上来的分片
 *    （Engine 的 noLocal）。
 *  - 不自己读 /v1/limits。这台机器上没有 Mirasim，账号额度由跑着 Mirasim 的机器 PUT 上来，
 *    经 Engine.ingestLimits() 进同一条路——服务端不长第二套口径。
 *  - 不认 IP 当身份。IP 会变（拨号、切网、代理），认它会把一台机器认成五台；
 *    身份一律用 installId，IP 只作「从哪连的」显示。
 *
 * 端点：
 *   GET  /health              探活，无需鉴权
 *   PUT  /shard               推一台机器的分片（v1 聚合态或 v2 原始行都收）
 *   PUT  /limits              推账号额度快照（跑着 Mirasim 的机器才有）
 *   GET  /payload             算好的 quota.json（契约 A，与本机 provider 逐字段同构）
 *   GET  /stream              SSE：payload 变了就推，秒级
 *   GET  /shards              在架分片原样返回（排查用）
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

import { Engine } from '../provider/lib/engine.mjs';
import { validateShard } from '../inbox/shared.mjs';
import { HubStore } from './store.mjs';

const MAX_BODY = 8 << 20;        // 8MB：v2 原始行上限 40k 行，够用且挡住乱塞
const RECOMPUTE_MS = 2000;       // payload 重算节流：SSE 订阅者再多也只算一次
const SSE_HEARTBEAT_MS = 25_000; // 心跳：穿反代与手机网络的保活，短于常见 60s 空闲超时

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

/** 常数时间比 token：长度不同直接假，避免按字节提前返回泄露前缀。 */
function tokenOk(given, want) {
  if (!want) return true;                 // 没配 token ⇒ 不鉴权（只该出现在本机测试里）
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const bearer = (req) => {
  const h = String(req.headers.authorization ?? '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : (req.headers['x-mq-token'] ?? null);
};

/** 请求体读全，超限即断——不给「慢慢灌满内存」留缝。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 反代后面拿真实来源 IP；只用于显示，不参与任何身份判断。 */
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  || req.socket.remoteAddress || null;

export class Hub {
  /**
   * @param opts.dataDir 数据目录（分片、额度快照、Engine 的账本/锚点都落这里）
   * @param opts.token   写接口的 bearer token；留空则不鉴权（仅测试）
   * @param opts.readToken 读接口的 token；留空表示读不鉴权（面板免配，账本金额敏感时再开）
   */
  constructor({ dataDir, token = null, readToken = null } = {}) {
    this.store = new HubStore(dataDir);
    this.token = token;
    this.readToken = readToken;
    this.engine = new Engine({
      forceOffline: true,   // 这台机器上没有 Mirasim，别去发现端口
      noLocal: true,        // 也没有任何人的 transcript，别扫本地
      ledgerFile: `${dataDir}/ledger.json`,
      anchorFile: `${dataDir}/anchor.json`,
      settingsFile: `${dataDir}/settings.json`,
      syncOpts: { configFile: `${dataDir}/no-sync.json` },   // hub 自己不参与多机同步
    });
    this.clients = new Set();     // SSE 订阅者
    this.#cached = null;
    this.#cachedAt = 0;
    this.#dirty = true;
    // 重启后先把已经在盘上的东西装回来，第一个请求就有完整答案，不用等谁再推一次
    const l = this.store.limits();
    if (l?.windows?.length) this.engine.ingestLimits(l, l.capturedAt);
  }

  #cached; #cachedAt; #dirty;

  /**
   * 算一份 payload。节流 RECOMPUTE_MS：合并 + 标定在机器多时不便宜，
   * 而一秒内连着三台机器推分片是常态，没必要算三遍。
   */
  payload(now = Date.now()) {
    if (!this.#dirty && this.#cached && now - this.#cachedAt < RECOMPUTE_MS) return this.#cached;
    const nowSec = now / 1000;
    const recs = this.store.shards(nowSec);
    // 所有机器对 hub 都是「外机」：它自己一行账本都没有，合并口径就是全机之和
    this.engine.ledger.adoptForeignShards(recs.map((r) => r.shard));
    this.engine.pointsAttrib.settle(this.engine.ledger, nowSec);
    const p = this.engine.payload();
    p.hub = {
      machines: recs.map((r) => ({
        key: r.key,
        id: r.shard?.machineId ?? r.key,
        account: r.shard?.account ?? null,
        generatedAt: r.shard?.generatedAt ?? null,
        receivedAt: r.receivedAt,
        ip: r.ip,                                   // 从哪连的，仅显示
        ...(r.shard?.speed?.rows?.length ? { speed: r.shard.speed } : {}),
      })).sort((a, b) => (b.generatedAt ?? 0) - (a.generatedAt ?? 0)),
      limitsFrom: this.store.limits()?.machineId ?? null,
      bytes: this.store.bytes(),
    };
    this.#cached = p; this.#cachedAt = now; this.#dirty = false;
    return p;
  }

  /** 有新数据进来：作废缓存并把新 payload 推给所有 SSE 订阅者。 */
  #bump() {
    this.#dirty = true;
    if (!this.clients.size) return;
    const line = `data: ${JSON.stringify(this.payload())}\n\n`;
    for (const res of this.clients) { try { res.write(line); } catch { /* 断了会走 close */ } }
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://hub');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const write = () => tokenOk(bearer(req), this.token);
    const read = () => tokenOk(bearer(req), this.readToken);

    if (path === '/health') return json(res, 200, { name: 'miraquota-hub', ok: true, machines: this.store.shards().length });

    if (req.method === 'PUT' && path === '/shard') {
      if (!write()) return json(res, 401, { error: 'token 不对' });
      let shard;
      try { shard = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: e.message }); }
      // 复用收件口那套校验：两处对「什么是合法分片」必须是同一个答案。
      // 第二个参数在那边是「分片自称的 account 要与登录身份一致」，hub 用的是共享 token
      // 而不是按人登录，这条绑定在这里没有对应物，所以传它自己的值把这一条空过。
      const why = validateShard(shard, shard?.account);
      if (why) return json(res, 400, { error: why });
      const key = this.store.putShard(shard, { ip: clientIp(req) });
      this.#bump();
      return json(res, 200, { ok: true, key });
    }

    if (req.method === 'PUT' && path === '/limits') {
      if (!write()) return json(res, 401, { error: 'token 不对' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!Array.isArray(body?.windows) || !body.windows.length) return json(res, 400, { error: '缺 windows' });
      if (!(body.capturedAt > 0)) return json(res, 400, { error: '缺 capturedAt（读到那一刻）' });
      const took = this.store.putLimits(body, { machineId: body.machineId ?? null });
      // 没采纳＝收到的比在架的还旧（机器时钟不齐、慢包后到），不该拿旧数覆盖新数
      if (took) { this.engine.ingestLimits(body, body.capturedAt); this.#bump(); }
      return json(res, 200, { ok: true, accepted: took });
    }

    if (req.method === 'GET' && path === '/payload') {
      if (!read()) return json(res, 401, { error: 'token 不对' });
      return json(res, 200, this.payload());
    }

    if (req.method === 'GET' && path === '/shards') {
      if (!read()) return json(res, 401, { error: 'token 不对' });
      return json(res, 200, this.store.shards().map((r) => r.shard));
    }

    if (req.method === 'GET' && path === '/stream') {
      if (!read()) return json(res, 401, { error: 'token 不对' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',   // no-transform：挡住反代的缓冲
        connection: 'keep-alive',
        'x-accel-buffering': 'no',                   // nginx 专用：不攒着，来一条发一条
      });
      res.write(`data: ${JSON.stringify(this.payload())}\n\n`);
      this.clients.add(res);
      const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch { /* close 会清理 */ } }, SSE_HEARTBEAT_MS);
      const bye = () => { clearInterval(beat); this.clients.delete(res); };
      req.on('close', bye); res.on('close', bye);
      return undefined;
    }

    return json(res, 404, { error: '没有这个端点' });
  }

  listen(port, host = '127.0.0.1') {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => { try { json(res, 500, { error: String(e?.message || e) }); } catch { /* 已发头 */ } });
    });
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server)));
  }

  close() {
    for (const res of this.clients) { try { res.end(); } catch { /* 已断 */ } }
    this.clients.clear();
    return new Promise((r) => (this.server ? this.server.close(r) : r()));
  }
}

/** 直接跑：node server/hub.mjs --data <目录> --port 4331 [--host 127.0.0.1] */
if (process.argv[1]?.endsWith('hub.mjs')) {
  const opt = (k, d = null) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const dataDir = opt('data', '/var/lib/miraquota-hub');
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(`${dataDir}/config.json`, 'utf8')); } catch { /* 无鉴权 */ }
  const hub = new Hub({ dataDir, token: cfg.token ?? null, readToken: cfg.readToken ?? null });
  const port = Number(opt('port', 4331));
  const host = opt('host', '127.0.0.1');
  await hub.listen(port, host);
  console.log(`[hub] ${host}:${port} · 数据 ${dataDir} · 写鉴权 ${cfg.token ? '开' : '关'} · 读鉴权 ${cfg.readToken ? '开' : '关'}`);
  const bye = () => hub.close().then(() => process.exit(0));
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
