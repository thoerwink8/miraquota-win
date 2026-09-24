/**
 * 账号额度从哪来：只有两个来源——本机 /v1/limits 实读，与 fleet-dao 的额度表（见 fleet-source）。
 *
 * 从前（v0.9.28 起）别的机器会把它读到的额度随分片捎过来，hub 另收一份；2026-09-24 起多机额度
 * 改由 fleet-dao 统一读，这两条路和 hub 通道一起下线——同一个账号的额度只该有一个远端来源，
 * 多一条就多一个「该信谁」的问题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostLedger, STATE_SCHEMA } from '../provider/lib/ledger.mjs';
import { LedgerSync } from '../provider/lib/ledger-sync.mjs';
import { Engine } from '../provider/lib/engine.mjs';
import { anchorsFrom } from '../provider/lib/anchors.mjs';
import { fakeInbox, inboxConfig } from './helpers/inbox-fixture.mjs';
import { startFakeFleet, sampleQuota } from '../scripts/fake-fleet.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-quota-'));

/**
 * 全注入的离线 Engine（本机 Mirasim「没开」）：状态都在临时目录，fleet 指向给定的 fleet.json。
 * 不注入 fleetOpts 就会去读真机的 ~/.miraquota/fleet.json，配过的机器上测试会真的联网。
 */
function offlineEngine(name, fleetFile = join(tmp, `${name}-no-fleet.json`)) {
  return new Engine({
    forceOffline: true,
    home: join(tmp, `${name}-home`),
    ledgerFile: join(tmp, `${name}-ledger.json`), anchorFile: join(tmp, `${name}-anchor.json`),
    settingsFile: join(tmp, `${name}-settings.json`), attribFile: join(tmp, `${name}-attrib.json`),
    calibratorFile: join(tmp, `${name}-calibration.json`),
    fleetOpts: { configFile: fleetFile },
    syncOpts: { configFile: join(tmp, 'none.json'), installId: '9e9e9e9e9e9e9e9e' },
  });
}

/** 起一个假 fleet-dao（回包里的读数都是 ageSec 秒前读的），写好 fleet.json，返回 { fake, file }。 */
async function fleetAged(t, ageSec, mutate = (b) => b) {
  const fake = await startFakeFleet({
    t,
    body: (now) => {
      const b = sampleQuota(now);
      const at = new Date((now - ageSec) * 1000).toISOString();
      for (const p of b.pools) {
        p.lastSuccessAt = at;
        p.lastAttempt = { ...p.lastAttempt, at };
        for (const w of p.windows) w.readAt = at;
      }
      return mutate(b);
    },
  });
  const file = join(tmp, `fleet-${ageSec}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ url: fake.url, token: fake.token }));
  return { fake, file };
}

function emptyLedger(name) {
  const file = join(tmp, `${name}-ledger.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: STATE_SCHEMA }));
  return new CostLedger({}, file);
}

const NOW = Math.floor(Date.now() / 1000) - 120;
const LIMITS = {
  capturedAt: NOW - 120,
  windows: [
    { label: '5h', used: 24_700, budget: 171_900, resetAt: NOW + 3600 },
    { label: '7d', used: 494_270, budget: 613_800, resetAt: NOW + 200_000 },
    { label: '7d_fable', used: 158_980, budget: 325_200, resetAt: NOW + 200_000, modelScoped: true },
  ],
};

test('limits windows become anchors without touching any on-disk state', () => {
  const a = anchorsFrom(LIMITS.windows, LIMITS.capturedAt);
  assert.equal(a.length, 3);
  assert.equal(a[0].capturedAt, LIMITS.capturedAt);
  assert.ok(Math.abs(a[0].usedPercent - 24_700 / 171_900 * 100) < 1e-9);
  assert.equal(a[2].modelScoped, true);
  // 坏行整条丢掉，不许算出 NaN 百分比印在主行上
  assert.deepEqual(anchorsFrom([{ label: '5h', used: 1, budget: 0, resetAt: NOW }], NOW), []);
  assert.deepEqual(anchorsFrom([{ label: '不认识的窗', used: 1, budget: 2, resetAt: NOW }], NOW), []);
  assert.deepEqual(anchorsFrom(null, NOW), []);
});

test('a shard no longer carries the account quota, and the engine ships none', async (t) => {
  // 一台连着 Mirasim 的机器同步一轮：发出去的分片里只有账本与速度，没有 limits 块。
  const box = await fakeInbox({ t });
  const engine = new Engine({
    forceOffline: true,
    home: join(tmp, 'ship-home'),
    ledgerFile: join(tmp, 'ship-ledger.json'), anchorFile: join(tmp, 'ship-anchor.json'),
    settingsFile: join(tmp, 'ship-settings.json'), attribFile: join(tmp, 'ship-attrib.json'),
    calibratorFile: join(tmp, 'ship-calibration.json'),
    fleetOpts: { configFile: join(tmp, 'ship-no-fleet.json') },
    syncOpts: {
      configFile: inboxConfig(box, 'ship', { extra: { intervalSec: 600 } }),
      machineId: 'ship', installId: '5b5b5b5b5b5b5b5b', cacheFile: join(tmp, 'ship-cache.json'),
    },
  });
  engine.ingestLimits(LIMITS, Date.now() / 1000);   // 这台手里有一份新鲜的实测
  await engine.poll();
  for (let i = 0; i < 100 && !box.shards.size; i++) await new Promise((r) => setTimeout(r, 20));
  const [shard] = [...box.shards.values()];
  assert.ok(shard, '一轮同步要真的发出分片，否则下面是空转');
  assert.equal(shard.machineId, 'ship');
  assert.equal('limits' in shard, false, '额度不再随分片走：它只认本机实读与 fleet-dao');
  assert.ok(!box.log.some((l) => l.includes('/limits')), '也不再有单独推额度的请求');

  // 读的一方收到老版本推来的、还带着 limits 的分片：照常合并账本，额度一个字不采信
  const reader = new LedgerSync({
    configFile: inboxConfig(box, 'reader', { extra: { intervalSec: 600 } }),
    machineId: 'reader', installId: '6c6c6c6c6c6c6c6c', cacheFile: join(tmp, 'reader-cache.json'),
  });
  box.shards.set('machine/old--0123456789ab', {
    schemaVersion: 1, machineId: 'old-box', installId: '0123456789abcdef', account: 'old', generatedAt: NOW,
    coverage: { fromSec: 0, toSec: NOW }, buckets: {}, scoped: {}, family: {}, limits: LIMITS,
  });
  const r = await reader.run(emptyLedger('reader'), NOW + 5);
  assert.ok(r.shards.some((s) => s.machineId === 'old-box'), '老分片照样读得到（账本还要合并）');
  const e2 = offlineEngine('read');
  e2.ledger.adoptForeignShards(r.shards);
  assert.equal(e2.payload().state, 'local', '别人分片里的额度不当锚点：本机没实读、没锚点，就是无数据');
});

test('with local Mirasim off, the account quota is fleet-dao\'s real reading, not a reckoning', async (t) => {
  const { fake, file } = await fleetAged(t, 180);
  const engine = offlineEngine('fl-real', file);
  await engine.fleet.refresh();
  const p = engine.payload();
  assert.equal(p.state, 'fleet');
  assert.equal(p.stateLabel, 'fleet 实读');
  assert.equal(p.measured, false, '本机 Mirasim 没实测——口径页据此说「实测倍率暂不可给」');
  assert.deepEqual(p.windows.map((w) => w.label), ['5h', '7d', '7d_claude', '7d_fable']);
  assert.ok(p.windows.every((w) => w.inferred === false), '实读不挂 ≈');
  const w7 = p.windows.find((w) => w.label === '7d');
  assert.deepEqual(w7.points, { used: 285_511, budget: 512_600 });
  assert.equal(w7.fullUSD, 512_600 * 0.01, '满额是官方除法，跟本机实测同一条路');
  assert.ok(Math.abs(w7.usedPercent - 285_511 / 512_600 * 100) < 1e-9);
  assert.equal(w7.modelGroup, undefined);
  assert.equal(p.windows.find((w) => w.label === '7d_fable').modelGroup, 'fable');
  assert.ok(p.windows.every((w) => w.etaSeconds === undefined), '打满钟点靠本机轨迹，不拿它套 fleet 的数');
  assert.match(p.detail, /本机 Mirasim 未运行：额度用 fleet-dao 3 分钟前读到的「Mirasim 中转」/);
  assert.match(p.detail, /他人占用已计入/);
  assert.equal(p.limitsFrom.source, 'fleet');
  assert.ok(Math.abs(p.limitsFrom.ageSeconds - 180) < 5);
  assert.equal(p.fleet.pools.length, 6, '账号池页要的整张表也在');
  assert.ok(!JSON.stringify(p).includes(fake.token), 'payload 里不许有令牌（feed 与 IPC 都会把它送出去）');
});

test('a live local reading beats fleet-dao, and so does a fresher stale one', async (t) => {
  const { file } = await fleetAged(t, 600);
  const engine = offlineEngine('fl-local', file);
  await engine.fleet.refresh();
  const now = Date.now() / 1000;
  engine.ingestLimits({ windows: LIMITS.windows }, now);
  assert.equal(engine.payload().state, 'exact', '本机实时来源在就用本机');
  assert.equal(engine.payload().windows.find((w) => w.label === '7d').points.budget, 613_800);

  engine.ingestLimits({ windows: LIMITS.windows }, now - 300);     // 本机 5 分钟前，fleet 10 分钟前
  engine.last = { at: now - 300, limits: { windows: LIMITS.windows } };
  assert.equal(engine.payload().state, 'stale', '谁更新用谁：本机那份更近');

  engine.last = { at: now - 900, limits: { windows: LIMITS.windows } };   // 本机 15 分钟前，比 fleet 旧
  assert.equal(engine.payload().state, 'fleet');
});

test('past its shelf life a fleet reading only anchors a reckoning, and it wears the ≈', async (t) => {
  const { file } = await fleetAged(t, 3600);                        // 60 分钟前 > 有效期 30 分钟
  const engine = offlineEngine('fl-old', file);
  await engine.fleet.refresh();
  const p = engine.payload();
  assert.equal(p.state, 'reckoned');
  assert.ok(p.windows.every((w) => w.inferred === true));
  assert.ok(p.windows.every((w) => w.points === undefined), '推算值不许印在「原始额度点」那一行');
  assert.equal(p.reckonFrom.source, 'fleet');
  assert.equal(p.reckonFrom.poolId, 'mirasim');
  assert.match(p.detail, /fleet-dao 的读数也已过期：按它 1(\.0)? 小时前读到的账号额度推算；他人占用已计到那一刻/);
  const w7 = p.windows.find((w) => w.label === '7d');
  assert.ok(w7.usedPercent >= 285_511 / 512_600 * 100 - 1e-9, '基线是它读到的账号百分比，只增不减');

  // 本机锚点更近时用本机的（判据只有谁更近）
  const now = Date.now() / 1000;
  engine.ingestLimits({ windows: LIMITS.windows }, now - 1200);
  const q = engine.payload();
  assert.equal(q.state, 'reckoned');
  assert.equal(q.reckonFrom, undefined);
  assert.match(q.detail, /他人占用不可见/);
});

test('two Mirasim pools stand in for nothing, and fleet off changes nothing', async (t) => {
  const { file } = await fleetAged(t, 60, (b) => {
    b.pools.push({ ...b.pools.find((p) => p.poolId === 'mirasim'), poolId: 'mirasim-2', name: '另一个 Mirasim' });
    return b;
  });
  const engine = offlineEngine('fl-two', file);
  await engine.fleet.refresh();
  const p = engine.payload();
  assert.equal(p.state, 'local', '认不出哪个是本机这个账号：宁可无数据，也不挑一个');
  assert.match(p.fleet.mirasim.skipped, /2 个 Mirasim 池/);
  assert.equal(p.fleet.pools.length, 7, '账号池页照样全列');

  const off = offlineEngine('fl-off');
  await off.poll();
  assert.deepEqual(off.payload().fleet, { state: 'off' }, '没配 fleet-dao：只给一个 off，界面据此给「接上」那张卡');
  assert.equal(off.payload().state, 'local');
});

test('a known-good local route is read once per poll, without rediscovering Mirasim', async (t) => {
  // 从前每一轮都先起一次 PowerShell 枚举全部进程（实测 1.4 秒）、再把缓存的路由读两遍。
  // 这里给一个认准了的路由（本地假 /v1/limits）：三轮 poll 只该有三次读取；读不通才清掉缓存。
  const hits = [];
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const srv = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers['x-api-key'] ?? ''}`);
    if (req.url !== '/v1/limits') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ windows: [{ name: '5h', used: 10, budget: 100, reset_at: reset }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const engine = new Engine({
    home: join(tmp, 'route-home'),
    ledgerFile: join(tmp, 'route-ledger.json'), anchorFile: join(tmp, 'route-anchor.json'),
    settingsFile: join(tmp, 'route-settings.json'), attribFile: join(tmp, 'route-attrib.json'),
    calibratorFile: join(tmp, 'route-calibration.json'),
    fleetOpts: { configFile: join(tmp, 'route-no-fleet.json') },
    syncOpts: { configFile: join(tmp, 'none.json'), installId: '8f8f8f8f8f8f8f8f' },
  });
  engine.cachedRouter = { port: srv.address().port, path: null, token: 'tok' };
  for (let i = 0; i < 3; i++) assert.equal(await engine.poll(), true);
  assert.deepEqual(hits, Array(3).fill('GET /v1/limits tok'), '一轮一次，不重读、不去探别的端口');
  assert.equal(engine.payload().state, 'exact');
  assert.equal(engine.payload().windows[0].points.used, 10);
});

test('a fully injected engine writes nothing into the default state dir', () => {
  // 2026-09-23 实咬：一条测试用 Engine 的默认路径跑 poll()，而账本正好在这一版升 schema，
  // 于是它把**真机的** ledger.json 就地迁移重写了。测试改用户的生产状态，比它要测的 bug 更糟。
  // 这条用「假 HOME」把默认路径整体挪到一个空目录，再在子进程里构造一个**全注入**的 Engine
  // 跑一轮会落盘的动作：默认目录里只要出现任何东西，就说明有模块没被注入（新模块加了落盘、
  // 忘了加注入，就会从这里冒出来）。
  const home = mkdtempSync(join(tmpdir(), 'mq-fakehome-'));
  const work = mkdtempSync(join(tmpdir(), 'mq-inject-'));
  // 假 HOME 里放一条 transcript：让账本这一轮**真的**有事可做（扫到 → 入桶 → 落盘），
  // 否则「没写默认目录」可能只是因为压根没写。
  const proj = join(home, '.claude', 'projects', 'p');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 's.jsonl'), JSON.stringify({
    timestamp: new Date().toISOString(), requestId: 'req_iso',
    message: { model: 'claude-fable-5-1', usage: { input_tokens: 1000, output_tokens: 10 } },
  }) + '\n');

  const script = `
    const { Engine } = await import(${JSON.stringify(new URL('../provider/lib/engine.mjs', import.meta.url).href)});
    const { join } = await import('node:path');
    const w = ${JSON.stringify(work)};
    const e = new Engine({
      forceOffline: true,
      ledgerFile: join(w, 'ledger.json'), anchorFile: join(w, 'anchor.json'),
      settingsFile: join(w, 'settings.json'), attribFile: join(w, 'attrib.json'),
      calibratorFile: join(w, 'calibration.json'),
      fleetOpts: { configFile: join(w, 'no-fleet.json') },
      // installFile 也得给：LedgerSync 构造函数里就会读/生成安装 id 并落盘，
      // 漏了它这条测试第一次跑就是这么红起来的（假 HOME 里冒出 .miraquota/install.json）。
      syncOpts: { configFile: join(w, 'none.json'), installFile: join(w, 'install.json') },
    });
    const now = Date.now() / 1000;
    e.ingestLimits({ capturedAt: now, windows: [
      { label: '7d', used: 5, budget: 100, resetAt: now + 86400 },
    ] }, now);
    e.ledger.refresh();
    e.pointsAttrib.settle(e.ledger, now);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60_000, windowsHide: true,
  });

  assert.ok(existsSync(join(work, 'ledger.db')), '注入的那份流水库要真写出来，否则这条测试是空转');
  // 标定（点数 + marks）现在跟着流水进同一个库，`calibration.json` 不再写——所以正控换成
  // 「库里真有那几行」，否则这条测试会变成空转（什么都没写也照样绿）。
  const db = new DatabaseSync(join(work, 'ledger.db'));
  assert.ok(db.prepare('SELECT COUNT(*) n FROM points').get().n > 0, '标定采样要真的落进库');
  // marks 这里会是 0：这一轮账本是空的（没有调用）⇒ 累计表是 `{}`，而 marks 是按模型记的，
  // 没有模型就写不出行。那是「没东西可标」，不是漏写——marks 的落库与还原在 point-cost 那条测。
  db.close();
  assert.equal(existsSync(join(work, 'calibration.json')), false, '标定已进库，JSON 不该再写');
  assert.equal(existsSync(join(home, '.miraquota')), false,
    '默认状态目录被碰了——有模块没走路径注入，测试正在改真机状态');
});
