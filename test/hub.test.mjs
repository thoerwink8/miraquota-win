/**
 * Hub：账本与账号额度的唯一真相。测的是「服务端算出来的和本机算出来的是同一个数」，
 * 以及三条硬边界——token 挡得住写、IP 不当身份、旧额度不覆盖新额度。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hub } from '../server/hub.mjs';
import { HubStore, safeKey } from '../server/store.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-hub-'));
let seq = 0;
const freshHub = (opts = {}) => new Hub({ dataDir: join(tmp, `d${++seq}`), token: 'sekrit', ...opts });

const NOW = Math.floor(Date.now() / 1000);
const MIN = Math.floor(NOW / 60) - 5;

/** v1 聚合态分片：完整应用推的就是这个形状。 */
const shardV1 = (machineId, installId, usd) => ({
  schemaVersion: 1, machineId, installId, generatedAt: NOW,
  coverage: { fromSec: NOW - 8 * 86400, toSec: NOW },
  buckets: { [MIN]: usd }, scoped: {}, family: { [`claude|${MIN}`]: usd }, unpriced: {},
});

const LIMITS = {
  capturedAt: NOW - 30,
  machineId: 'vmi3551059',
  windows: [{ label: '7d', used: 100_000, budget: 613_800, resetAt: NOW + 200_000 }],
};

/** 直接调 handle()，不占端口——测的是逻辑，不是 TCP。 */
function call(hub, method, path, { body = null, token = 'sekrit', ip = null } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = {
      method, url: path,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}) },
      socket: { remoteAddress: '127.0.0.1' },
      on(ev, fn) {
        if (ev === 'data' && body != null) fn(Buffer.from(JSON.stringify(body)));
        if (ev === 'end') fn();
        return this;
      },
      destroy() {},
    };
    const res = {
      statusCode: 0, headers: null,
      writeHead(code, h) { this.statusCode = code; this.headers = h; },
      write(s) { chunks.push(s); },
      end(s) { if (s) chunks.push(s); resolve({ status: this.statusCode, body: safeJson(chunks.join('')) }); },
      on() { return this; },
    };
    hub.handle(req, res);
  });
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

test('machine keys are washed before they become file names', () => {
  assert.equal(safeKey('DESKTOP-A1B2.local'), 'desktop-a1b2-local');
  assert.equal(safeKey('../../etc/passwd'), 'etc-passwd', '路径穿越要被洗掉，分片自报的字段不可信');
  assert.equal(safeKey(''), '');
});

test('the hub merges every machine and answers with one payload', async () => {
  const hub = freshHub();
  assert.equal((await call(hub, 'PUT', '/shard', { body: shardV1('win-box', 'aaaaaaaaaaaaaaaa', 12) })).status, 200);
  assert.equal((await call(hub, 'PUT', '/shard', { body: shardV1('mac-box', 'bbbbbbbbbbbbbbbb', 8) })).status, 200);
  assert.equal((await call(hub, 'PUT', '/limits', { body: LIMITS })).status, 200);

  const { status, body: p } = await call(hub, 'GET', '/payload');
  assert.equal(status, 200);
  // 额度是别的机器推来的，但走的是 ingestLimits 同一条路 ⇒ 服务端也算「实测」
  assert.equal(p.state, 'exact');
  const w = p.windows.find((x) => x.label === '7d');
  assert.equal(w.points.used, 100_000);
  assert.equal(w.fullUSD, 613_800 * 0.01);
  // 合并口径 = 全机之和，服务端自己一行账本都没有
  assert.ok(Math.abs(w.spentUSD - 20) < 1e-9, '12 + 8，两台机器的账本合在一起');
  assert.equal(p.hub.machines.length, 2);
  assert.equal(p.hub.limitsFrom, 'vmi3551059');
});

test('identity is the installId, never the IP', async () => {
  const hub = freshHub();
  // 同一台机器换了 IP（拨号、切网、走代理）仍是一台，不该变成两台
  await call(hub, 'PUT', '/shard', { body: shardV1('win-box', 'aaaaaaaaaaaaaaaa', 5), ip: '1.2.3.4' });
  await call(hub, 'PUT', '/shard', { body: shardV1('win-box', 'aaaaaaaaaaaaaaaa', 7), ip: '5.6.7.8' });
  const { body: p } = await call(hub, 'GET', '/payload');
  assert.equal(p.hub.machines.length, 1);
  assert.equal(p.hub.machines[0].ip, '5.6.7.8', 'IP 只作显示，取最近一次');
  assert.ok(Math.abs(p.windows.find((x) => x.label === '7d')?.spentUSD - 7) < 1e-9, '整份覆盖，不是累加');
});

test('a replayed ancient snapshot is refused, but ordinary clock skew is not', async () => {
  const hub = freshHub();
  await call(hub, 'PUT', '/limits', { body: LIMITS });
  // 离线很久的机器上线后回放一份陈年快照：拦掉
  const ancient = { ...LIMITS, capturedAt: NOW - 3600, windows: [{ ...LIMITS.windows[0], used: 1 }] };
  assert.equal((await call(hub, 'PUT', '/limits', { body: ancient })).body.accepted, false);
  assert.equal((await call(hub, 'GET', '/payload')).body.windows.find((x) => x.label === '7d').points.used, 100_000);

  // 时钟慢几十秒的机器推的**新**读数必须收：实测本机比服务器慢 48 秒，按发送方时钟
  // 排序会让它的新数长期被别人的旧数挡住，「随时同步」就成了「随那台钟快的机器」
  const slowClock = { ...LIMITS, machineId: 'slow-box', capturedAt: NOW - 50, windows: [{ ...LIMITS.windows[0], used: 222_222 }] };
  assert.equal((await call(hub, 'PUT', '/limits', { body: slowClock })).body.accepted, true);
  const { body: p } = await call(hub, 'GET', '/payload');
  assert.equal(p.windows.find((x) => x.label === '7d').points.used, 222_222);
  assert.equal(p.hub.limitsFrom, 'slow-box');
});

test('a server with no Mirasim never tells the user to go start Mirasim', async () => {
  // 这句会经 hub-client 合并后印在用户面板上；服务器上本来就没有 Mirasim
  const empty = freshHub();
  assert.match((await call(empty, 'GET', '/payload')).body.detail, /还没有任何机器推过账号额度/);
  // 刚过 STALE_AFTER（90 秒）：还在实测态，只是有点旧
  const stale = freshHub();
  await call(stale, 'PUT', '/limits', { body: { ...LIMITS, capturedAt: NOW - 300 } });
  const d1 = (await call(stale, 'GET', '/payload')).body.detail;
  assert.match(d1, /账号额度已 \d+ 分钟没人推新的/);
  assert.doesNotMatch(d1, /接口/, '服务器这边没有「接口未回传」这回事');

  // 超过 RECKON_AFTER（600 秒）：转推算态
  const old = freshHub();
  await call(old, 'PUT', '/limits', { body: { ...LIMITS, capturedAt: NOW - 590 } });
  old.engine.last.at = NOW - 590 - 60;   // 把它推过 RECKON_AFTER，走推算分支
  const d2 = (await call(old, 'GET', '/payload')).body.detail;
  assert.match(d2, /没有机器推新的账号额度/);
  assert.doesNotMatch(d2, /Mirasim 未运行/, '服务器不该叫用户去开一个它这里没有的东西');
});

test('writes need the token, health does not', async () => {
  const hub = freshHub();
  assert.equal((await call(hub, 'PUT', '/shard', { body: shardV1('x', 'cccccccccccccccc', 1), token: 'wrong' })).status, 401);
  assert.equal((await call(hub, 'PUT', '/limits', { body: LIMITS, token: null })).status, 401);
  assert.equal((await call(hub, 'GET', '/health', { token: null })).status, 200);
  // 读默认不鉴权：面板填个地址就能看，账本要保密再开 readToken
  assert.equal((await call(hub, 'GET', '/payload', { token: null })).status, 200);
  const shut = new Hub({ dataDir: join(tmp, 'ro'), token: 'w', readToken: 'r' });
  assert.equal((await call(shut, 'GET', '/payload', { token: null })).status, 401);
  assert.equal((await call(shut, 'GET', '/payload', { token: 'r' })).status, 200);
});

test('garbage shards are refused, not stored', async () => {
  const hub = freshHub();
  for (const bad of [
    { schemaVersion: 3, machineId: 'a', installId: 'aaaaaaaaaaaaaaaa', generatedAt: NOW, coverage: { fromSec: 0, toSec: 1 } },
    { schemaVersion: 1, installId: 'aaaaaaaaaaaaaaaa', generatedAt: NOW, coverage: { fromSec: 0, toSec: 1 }, buckets: {} },
    { schemaVersion: 1, machineId: 'a', installId: 'nothex', generatedAt: NOW, coverage: { fromSec: 0, toSec: 1 }, buckets: {} },
  ]) {
    assert.equal((await call(hub, 'PUT', '/shard', { body: bad })).status, 400);
  }
  assert.equal((await call(hub, 'GET', '/payload')).body.hub.machines.length, 0);
});

test('the store forgets machines that stopped reporting', () => {
  const store = new HubStore(join(tmp, 'ttl'));
  store.putShard({ ...shardV1('gone', 'dddddddddddddddd', 1), generatedAt: NOW - 9 * 86400 });
  store.putShard(shardV1('here', 'eeeeeeeeeeeeeeee', 1));
  const rows = store.shards(NOW);
  assert.deepEqual(rows.map((r) => r.shard.machineId), ['here'], '超过保留期的分片读时即清');
});

test('a real client pushes over HTTP and reads the others back', async () => {
  const { CostLedger } = await import('../provider/lib/ledger.mjs');
  const { LedgerSync } = await import('../provider/lib/ledger-sync.mjs');
  const { writeFileSync } = await import('node:fs');

  const hub = new Hub({ dataDir: join(tmp, 'rt'), token: 'sekrit' });
  const srv = await hub.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;

  const client = (name, installId, usd) => {
    const cfg = join(tmp, `${name}-sync.json`);
    writeFileSync(cfg, JSON.stringify({ hub: base, token: 'sekrit', intervalSec: 600 }));
    const led = join(tmp, `${name}-led.json`);
    writeFileSync(led, JSON.stringify({ schemaVersion: 2, buckets: { [MIN]: usd } }));
    return {
      sync: new LedgerSync({ configFile: cfg, repoDir: join(tmp, `${name}-repo`), machineId: name, installId, cacheFile: join(tmp, `${name}-cache.json`) }),
      ledger: new CostLedger({}, led),
    };
  };

  const a = client('win-box', 'aaaaaaaaaaaaaaaa', 4);
  const b = client('mac-box', 'bbbbbbbbbbbbbbbb', 6);
  assert.equal(a.sync.mode, 'hub', '配了 hub 就走 hub，不再碰 git 仓');

  await b.sync.run(b.ledger, NOW);
  const ra = await a.sync.run(a.ledger, NOW + 1);
  assert.equal(ra.state, 'ok');
  assert.equal(ra.hub, base);
  assert.deepEqual(ra.shards.map((s) => s.machineId), ['mac-box'], '读回他机、剔掉自己');

  // 跑着 Mirasim 的那台把账号额度也送上去
  assert.equal(await a.sync.pushLimits(LIMITS), true);
  const p = await (await fetch(`${base}/payload`)).json();
  assert.equal(p.windows.find((x) => x.label === '7d').points.used, 100_000);
  assert.ok(Math.abs(p.windows.find((x) => x.label === '7d').spentUSD - 10) < 1e-9, '4 + 6 两台合并');
  assert.equal(p.hub.limitsFrom, 'win-box');

  // git 通道那两个目录一个都不该建出来——hub 模式零本地仓
  assert.equal(existsSync(join(tmp, 'win-box-repo')), false);
  await hub.close();
});

test('a restarted hub answers from disk before anyone pushes again', async () => {
  const dir = join(tmp, 'restart');
  const a = new Hub({ dataDir: dir, token: 'sekrit' });
  await call(a, 'PUT', '/shard', { body: shardV1('win-box', 'aaaaaaaaaaaaaaaa', 3) });
  await call(a, 'PUT', '/limits', { body: LIMITS });

  const b = new Hub({ dataDir: dir, token: 'sekrit' });   // 重启
  const { body: p } = await call(b, 'GET', '/payload');
  assert.equal(p.state, 'exact', '额度快照在盘上，重启后第一个请求就有完整答案');
  assert.equal(p.windows.find((x) => x.label === '7d').points.used, 100_000);
  assert.equal(p.hub.machines.length, 1);
});
