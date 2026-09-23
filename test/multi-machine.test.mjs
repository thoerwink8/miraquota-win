import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostLedger, STATE_SCHEMA } from '../provider/lib/ledger.mjs';
import { LedgerSync, cleanMachineId, retryOnce, explainSyncError } from '../provider/lib/ledger-sync.mjs';
import { Calibrator } from '../provider/lib/calibrator.mjs';
import { PointsAttributor } from '../provider/lib/points-attrib.mjs';
import { readEnabledModels, Engine } from '../provider/lib/engine.mjs';
import { Pricing } from '../provider/lib/pricing.mjs';
import { startHub, hubConfig } from './helpers/hub-fixture.mjs';

// 全部状态走注入的临时目录，不碰 ~/.miraquota；远端是本地 hub（真 HTTP），不依赖网络。
const tmp = mkdtempSync(join(tmpdir(), 'mq-multi-'));

/** 写一份指向该 hub 的 sync.json，返回路径。 */
const syncConfig = (name, base, intervalSec = 600) => hubConfig(name, base, { extra: { intervalSec } });

/** 预置聚合态的账本（pricing 不参与查询，传空对象即可）。 */
/** 带真价目表（内置官方价、无缓存）的空账本——测网关行解析要用到 pricing.cost */
function pricedLedger(name) {
  const file = join(tmp, `${name}-ledger.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: STATE_SCHEMA }));
  return new CostLedger(new Pricing(join(tmp, 'no-cache.json')), file);
}

/** 机器行去掉收件口身份字段（key/account），老测试只比 id/时间/本机标记 */
const bare = (rows) => rows.map(({ id, lastShardSec, self }) => ({ id, lastShardSec, self }));

/** 预置当前格式的聚合态账本；旧 schema 会被当成「双计过的旧账」清空重建，别拿它当预置。 */
function ledgerWith(name, data) {
  const file = join(tmp, `${name}-ledger.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: STATE_SCHEMA, ...data }));
  return new CostLedger({}, file);
}

test('machine ids are cleaned into branch-safe short names', () => {
  assert.equal(cleanMachineId('DESKTOP-A1B2.local'), 'desktop-a1b2-local');
  assert.equal(cleanMachineId('__'), 'machine');
});

test('two machines publish shards to the hub and read each other', async (t) => {
  const hub = await startHub(t);

  const T = Math.floor(Date.now() / 1000) - 120;   // 必须靠近现在：hub 读分片时会把过保留期的清掉
  const MIN = Math.floor(T / 60) - 5;   // 桶分钟取 T 附近，避免被任何窗口逻辑边界干扰
  const ledgerA = ledgerWith('alpha', {
    buckets: { [MIN]: 2 },
    family: { [`claude|${MIN}`]: 2 },
  });
  const ledgerB = ledgerWith('beta', {
    buckets: { [MIN]: 3, [MIN + 1]: 5 },
    family: { [`claude|${MIN + 1}`]: 5, [`gpt|${MIN + 1}`]: 1 },
  });
  // 两台机器必须各有各的 installId：不注入就都读真机 ~/.miraquota/install.json，两台同 id
  // ⇒ 各自把对方的分片当成「自己那份」过滤掉（hub 按 installId 认身份，git 通道不认）。
  const syncA = new LedgerSync({ configFile: syncConfig('alpha', hub.base), machineId: 'alpha', installId: 'aaaaaaaaaaaaaaaa' });
  const syncB = new LedgerSync({ configFile: syncConfig('beta', hub.base), machineId: 'beta', installId: 'bbbbbbbbbbbbbbbb' });

  // B 先发布；A 发布后即应读到 B 的分片
  const rb = await syncB.run(ledgerB, T);
  assert.equal(rb.error, undefined);
  const ra = await syncA.run(ledgerA, T + 1);
  assert.equal(ra.error, undefined);
  // 机器明细：本机 lastShardSec = 发布成功时刻，外机 = 其分片的 generatedAt
  assert.deepEqual(bare(ra.machines), [
    { id: 'alpha', lastShardSec: T + 1, self: true },
    { id: 'beta', lastShardSec: T, self: false },
  ]);
  assert.equal(ra.shards.length, 1);
  const shard = ra.shards[0];
  assert.equal(shard.machineId, 'beta');
  assert.equal(shard.generatedAt, T);
  assert.equal(shard.coverage.toSec, T);
  assert.deepEqual(shard.buckets, { [MIN]: 3, [MIN + 1]: 5 });

  // 合并查询：spent = 本机 + 外机分钟桶之和；localOnly 保留纯本机口径
  const from = MIN * 60, to = (MIN + 2) * 60;
  ledgerA.adoptForeignShards(ra.shards);
  assert.equal(ledgerA.spent(from, to), 10);
  assert.equal(ledgerA.spent(from, to, { localOnly: true }), 2);
  assert.equal(ledgerA.activeMinutes(from, to), 2);
  assert.equal(ledgerA.activeMinutes(from, to, { localOnly: true }), 1);
  assert.equal(ledgerA.familySpent(from, to, 'claude'), 7);
  assert.equal(ledgerA.familySpent(from, to, 'claude', { localOnly: true }), 2);
  assert.ok(ledgerA.familyIds().includes('gpt'));   // 外机独有家族进入归因权重候选

  // 覆盖区间可查；分片过期（generatedAt 早于保留窗）后不再算在场
  assert.equal(ledgerA.foreignCoverage(T + 100).length, 1);
  assert.equal(ledgerA.foreignCoverage(T + 9 * 86400).length, 0);

  // B 分片缺失时退回本机值
  ledgerA.adoptForeignShards([]);
  assert.equal(ledgerA.spent(from, to), 2);
  assert.equal(ledgerA.familySpent(from, to, 'claude'), 2);

  // 覆盖式发布：A 再发一轮，B 读回来仍是同一台机器一份（hub 按 installId 整份覆盖，不留历史）
  await syncA.run(ledgerA, T + 700);
  const rb2 = await syncB.run(ledgerB, T + 701);
  assert.deepEqual(rb2.shards.map((s) => s.machineId), ['alpha']);
  assert.equal(rb2.shards[0].generatedAt, T + 700);
});

/** 只需要 exportShard 的假账本。installId 必须给：hub 会校验（git 通道不校验，所以从前没暴露）。 */
const fakeLedger = () => ({
  exportShard: (id, now) => ({
    schemaVersion: 1, machineId: id, installId: 'abcdef0123456789', generatedAt: now,
    coverage: { fromSec: 0, toSec: now }, buckets: {}, scoped: {}, family: {},
  }),
});

test('a broken endpoint is reported in status without throwing, and one failure is not red yet', async () => {
  const sync = new LedgerSync({
    // 没人听的端口：真失败，但不是「不认识的通道」
    configFile: syncConfig('broken', 'http://127.0.0.1:9'),
    machineId: 'broken',
    retryDelayMs: 5,
  });
  const r = await sync.run(fakeLedger(), 1000);
  assert.ok(r.error);                 // 失败进状态字段
  assert.equal(r.state, 'warn');      // 抖动不立刻报红：首轮失败只到中间态（UI 黄）
  assert.equal(r.pushOk, false);
  assert.equal(r.failStreak, 1);
  // 不抛异常、不阻断；push 没成功 ⇒ 本机尚无成功发布时刻
  assert.deepEqual(bare(r.machines), [{ id: 'broken', lastShardSec: null, self: true }]);

  const r2 = await sync.run(fakeLedger(), 1000 + 600);
  assert.equal(r2.state, 'error');    // 连续 2 轮失败 ⇒ 才进故障态（UI 红）
  assert.equal(r2.failStreak, 2);
});

test('a flaky first attempt is retried inside the round and does not count as a failure', async (t) => {
  // 实测本地代理偶发 SSL_ERROR_SYSCALL、紧接着的访问全部成功。这里让第一次 fetch 直接抛，
  // 验单轮内重试把它吃掉（传输层换成 hub 之后，「抖动」的形状就是 fetch 抛）。
  const hub = await startHub(t);
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (...a) => {
    if (++n === 1) throw new Error('fetch failed: OpenSSL SSL_read: SSL_ERROR_SYSCALL');
    return realFetch(...a);
  };
  try {
    const sync = new LedgerSync({
      configFile: syncConfig('flaky', hub.base), machineId: 'flaky', retryDelayMs: 50,
    });
    const r = await sync.run(fakeLedger(), 4_000_000);
    assert.ok(n >= 2, '第一次真的被拒了');
    assert.equal(r.error, undefined);                // 抖动被单轮内重试吃掉
    assert.equal(r.state, 'ok');
    assert.equal(r.failStreak, undefined);
  } finally { globalThis.fetch = realFetch; }
});

test('retryOnce runs the second attempt and reports the latest reason when both fail', async () => {
  let n = 0;
  assert.equal(await retryOnce(async () => { if (++n === 1) throw new Error('抖一下'); return 'ok'; }, 5), 'ok');
  assert.equal(n, 2);
  await assert.rejects(retryOnce(async () => { throw new Error(`第 ${++n} 次`); }, 5), /第 4 次/);
});

test('common transport failures get a plain-language reading, unknown ones stay raw', () => {
  // 人话归纳只是导读，原文另存 sync.error（UI 当次要小字），归纳不出来时返回 null。
  // 归纳表本身与通道无关（现在只剩 HTTP 两条），所以照样拿真报错文本钉住。
  assert.equal(explainSyncError('fetch failed'), '网络连不上（代理或网络问题）');
  assert.equal(explainSyncError('connect ECONNREFUSED 127.0.0.1:9'), '网络连不上（代理或网络问题）');
  assert.equal(explainSyncError('HTTP 401 (401)'), '名字或口令不对（在多机页重新登录）');
  // 权限类常同时含别的关键词，必须判成权限而不是网络
  assert.equal(explainSyncError('permission denied (403)'), '凭据无效或无权限');
  assert.equal(explainSyncError('HTTP 404 (404)'), '仓库/收件口地址不对或已不存在');
  assert.equal(explainSyncError('某个没见过的毛病'), null);
});

test('sync state machine: connecting before first success, ok while fresh, stale falls back', async (t) => {
  const hub = await startHub(t);
  const T = 2_000_000;
  const a = new LedgerSync({ configFile: syncConfig('sa', hub.base), machineId: 'sa' });
  assert.equal(a.status(T).state, 'connecting');   // 启用但从未成功 ⇒ 连接中（UI 灰）
  const r = await a.run(ledgerWith('sa', { buckets: {} }), T);
  assert.equal(r.state, 'ok');                     // 最近一轮成功且无 error ⇒ 已接入（UI 绿）
  assert.equal(r.intervalSec, 600);
  // 过期判定：距上次成功超过 2×intervalSec 后不再算已接入
  assert.equal(a.status(T + 1200).state, 'ok');
  assert.equal(a.status(T + 1201).state, 'connecting');
});

test('calibration coverage gate keeps fully covered observations and falls back otherwise', () => {
  // 采样保留窗按当前时刻剪裁，时间线必须锚在现在附近。
  // 时间线：obs1 [B+0,B+60]（有支出有增量）；随后点数增量挂起 680 秒等不到支出
  // ⇒ 判他机活跃段 [B+120,B+800]，FOREIGN_PAD=300 扩散后与 obs1、obs2 都相交。
  const B = Math.floor(Date.now() / 1000) - 3600;
  const samples = [[0, B], [100, B + 60], [200, B + 120], [300, B + 800], [400, B + 830]];
  const spend = { [`${B}-${B + 60}`]: 1, [`${B + 800}-${B + 830}`]: 2 };
  const mkLedger = (coverage) => ({
    spent: (from, to) => spend[`${from}-${to}`] ?? 0,
    ...(coverage ? { foreignCoverage: () => coverage } : {}),
  });
  let n = 0;
  const fresh = () => {
    const cal = new Calibrator(join(tmp, `cal-${n++}.json`));
    for (const [used, at] of samples) cal.record([{ label: '5h', used, budget: 100000, resetAt: B + 9_999 }], at);
    return cal;
  };

  // 无同步（无覆盖信息）：两段观测全被他机剔除兜底吃掉，无样本
  assert.equal(fresh().estimate('5h', mkLedger(null), 100000), null);

  // B 机分片覆盖到 B+100：obs1(to=B+60≤界) 全覆盖保留，obs2(to=B+830>界) 走兜底剔除
  const partial = fresh().estimate('5h',
    mkLedger([{ machineId: 'b', fromSec: 0, toSec: B + 100, generatedAt: B + 900 }]), 100000);
  assert.equal(partial.observations, 1);
  assert.equal(partial.foreignDropped, 1);

  // B 机分片覆盖到 B+1000：两段都全覆盖，不再受 foreign-drop 误伤
  const full = fresh().estimate('5h',
    mkLedger([{ machineId: 'b', fromSec: 0, toSec: B + 1000, generatedAt: B + 1100 }]), 100000);
  assert.equal(full.observations, 2);
  assert.equal(full.foreignDropped, 0);
});

test('attribution settle window widens to 2x the sync interval', () => {
  const W = (used) => [{ label: '5h', used, budget: 100000, resetAt: 9_999_999, modelScoped: false }];
  const ledger = {
    familyIds: () => ['claude'],
    familySpent: (from, to) => (from >= 1000 && to <= 1060 ? 1 : 0),
  };
  const a = new PointsAttributor(join(tmp, 'attrib.json'));
  a.relaxSettle(600);   // max(300, 2×600) = 1200
  a.record(W(0), 1000);
  a.record(W(10), 1060);
  a.settle(ledger, 1060 + 400);    // 旧默认 300 已到，但放宽后未到 ⇒ 不入桶
  assert.equal(a.familyPoints(0, 999999, 'claude'), 0);
  a.settle(ledger, 1060 + 1200);   // 放宽后的静置期满
  assert.ok(Math.abs(a.familyPoints(0, 999999, 'claude') - 10) < 1e-6);
});

test('without sync.json the feature is fully off: nothing created, no payload field', async () => {
  const missing = join(tmp, 'no-such-sync.json');
  const off = new LedgerSync({ configFile: missing, machineId: 'off' });
  assert.equal(off.enabled, false);
  assert.equal(await off.run(ledgerWith('off', { buckets: {} })), null);

  const engine = new Engine({ forceOffline: true, syncOpts: { configFile: missing } });
  assert.ok(!('sync' in engine.payload()));
});

test('a sync.json left over from the retired git channel is off, and says how to switch', async () => {
  // git 通道 2026-09-23 退役。配着它的机器不静默失联：当未配置，但打一行说清怎么换。
  const file = join(tmp, 'legacy-git-sync.json');
  writeFileSync(file, JSON.stringify({ remote: 'https://github.com/x/y.git', intervalSec: 600 }));
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const s = new LedgerSync({ configFile: file, machineId: 'legacy' });
    assert.equal(s.enabled, false, '退役的通道一律当未配置');
    assert.equal(s.mode, null);
  } finally { console.warn = realWarn; }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /已退役的 git 通道/);
  assert.match(warns[0], /--hub/, '要说清怎么换到现役通道');
});

test('with sync configured the payload carries a sync status field', async (t) => {
  const hub = await startHub(t);
  const engine = new Engine({
    forceOffline: true,
    syncOpts: { configFile: syncConfig('engine', hub.base), machineId: 'engine' },
  });
  // 只比同步状态本身：这个 Engine 读的是真机的账本与锚点（非隔离），
  // 用量字段会随本机数据变，deepEqual 整块会被无关字段带崩。
  const { usage, ...status } = engine.payload().sync;
  assert.deepEqual({ ...status, machines: bare(status.machines) }, {
    state: 'connecting',
    mode: 'hub',
    pushOk: false,
    intervalSec: 600,
    hub: hub.base,
    machines: [{ id: 'engine', lastShardSec: null, self: true }],
  });
});

test('the 7d page can say which machine spent what, and what nobody claimed', () => {
  // 官方点数只有账号级一个总数，拆不出用户；能拆的只有各机自己的账本。所以每台机器
  // 用它自己的分片算，剩下的进「未接入」——那条残差同时装着没接入的人和账本漏记，
  // 界面必须说清（本机实测账本偏低约 3%，残差在这个量级基本是漏记而非他人）。
  const MIN = 29_000_000;
  const led = ledgerWith('split', {
    buckets: { [MIN]: 10, [MIN + 1]: 4 },
    scoped: { [`fable|${MIN + 1}`]: 4 },      // 本机这 4 刀走 fable
  });
  led.adoptForeignShards([{
    schemaVersion: 1, machineId: 'other', generatedAt: MIN * 60,
    coverage: { fromSec: 0, toSec: MIN * 60 },
    buckets: { [MIN]: 6 }, scoped: {}, family: {},
  }]);
  const rows = led.perMachineSpent((MIN - 10) * 60, (MIN + 2) * 60, { group: 'fable', selfId: 'me' });
  assert.deepEqual(rows.map((r) => [r.machineId, r.self, r.usd, r.groupUSD]), [
    ['me', true, 14, 4],
    ['other', false, 6, 0],
  ]);
  // 折算后换算成点：本机 (14 + 1×4) ÷ 0.01 = 1800，他机 6 ÷ 0.01 = 600
  const pts = (r) => (r.usd + r.groupUSD) / 0.01;
  assert.equal(pts(rows[0]), 1800);
  assert.equal(pts(rows[1]), 600);
  // 合并口径不受影响：拆分走的是分片本体，不碰合并索引
  assert.equal(led.spent((MIN - 10) * 60, (MIN + 2) * 60, { includeOpenMinute: true }), 20);

  const engine = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.ok(engine.includes('unattributedPoints: Math.max(0, official - known)'), '残差不给负数');
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  // 残差的名字是「未同步账本的机器」（用户 2026-09-02 拍板归成一类）：没跑 MiraQuota 的人、
  // 关了同步或分片过期的机器、加各机账本的时差漏记。旧名「未接入」会让人只想到第一种。
  assert.match(renderer, /未同步账本的机器/);
  assert.doesNotMatch(renderer, /未接入/);
  assert.match(renderer, /以及各机账本自己的时差漏记/);
});

test('a cold start uses the shards fetched by the previous round, before any network', async (t) => {
  // 实测踩过：进程启动到第一轮同步跑完之前只认本机账本，美元与标定按单机口径给，
  // 而他机分片就躺在本地缓存里（--once 更是活不到第一轮同步完成）。
  const hub = await startHub(t);
  // cacheFile 必须注入：不注入就读到本机真实的 ~/.miraquota/inbox-shards.json，
  // 那里面是这台机器此刻真在同步的分片，测试结果会随开发机的状态飘（实咬一次）。
  const a = new LedgerSync({
    configFile: syncConfig('cold-a', hub.base), machineId: 'a', installId: 'aaaaaaaaaaaaaaaa',
    cacheFile: join(tmp, 'cold-a-cache.json'), inboxUrl: null,
  });
  const b = new LedgerSync({
    configFile: syncConfig('cold-b', hub.base), machineId: 'b', installId: 'bbbbbbbbbbbbbbbb',
    cacheFile: join(tmp, 'cold-b-cache.json'), inboxUrl: null,
  });
  // 时间必须靠近现在：hub 读分片时会把过保留期的清掉，1970 年的时间戳会被当场清空。
  const T = Math.floor(Date.now() / 1000) - 120;
  const MIN = Math.floor(T / 60) - 5;
  await a.run(ledgerWith('cold-a', { minutes: { [MIN]: { usd: 3 } } }), T);
  await b.run(ledgerWith('cold-b', { minutes: {} }), T);
  assert.equal(b.shards.length, 1, 'b 这一轮应读到 a 的分片');

  // 新进程：不跑 run()，只装缓存——拿到的仍是 a 的分片
  const bRestarted = new LedgerSync({
    configFile: syncConfig('cold-b2', hub.base), machineId: 'b', installId: 'bbbbbbbbbbbbbbbb',
    cacheFile: join(tmp, 'cold-b-cache.json'), inboxUrl: null,
  });
  assert.deepEqual(bRestarted.shards, [], '构造时不该自带分片');
  const cached = await bRestarted.loadCachedShards();
  assert.equal(cached.length, 1);
  assert.equal(cached[0].machineId, 'a');
});

test('a relay call the price list cannot price is booked as tokens, never dropped', () => {
  // 点已经扣了、美元算不出——记 token，让它在多机页有名有姓，而不是消失进残差。
  // 回填让 token 变大时补差额；同一行重读不重复计。
  const led = pricedLedger('unpriced');
  const MIN = 29_100_000;
  const row = (tok) => JSON.stringify({
    id: 'u1', ts: new Date(MIN * 60 * 1000).toISOString(), agent: 'kimi', model: 'kimi-k3', status: 200,
    viaRelay: true, leg: 'relay', upstreamHost: 'relay.mirasim.ai', providerCallId: 'pc1', input: tok, output: 0,
  });
  // 走 #parseGateway 的公开替身，和生产路径同一段代码
  led.ingestGatewayLine(row(1000), 0);
  led.ingestGatewayLine(row(1000), 0);      // 重读不重复
  led.ingestGatewayLine(row(1500), 0);      // 回填变大补差额
  assert.deepEqual(led.unpricedUsage((MIN - 1) * 60, (MIN + 1) * 60), [{ model: 'kimi-k3', tokens: 1500 }]);
  assert.equal(led.spent((MIN - 1) * 60, (MIN + 1) * 60, { includeOpenMinute: true }), 0, '没价就没美元，不能瞎编');
  // 分片带着 unpriced，他机的无价调用也能进这一行
  assert.deepEqual(Object.keys(led.exportShard('me').unpriced), ['kimi-k3|' + MIN]);
});

test('dispatch calls land in their own family instead of vanishing', () => {
  const led = pricedLedger('dispatch');
  const MIN = 29_100_100;
  led.ingestGatewayLine(JSON.stringify({
    id: 'd1', ts: new Date(MIN * 60 * 1000).toISOString(), agent: 'claude', provider: 'anthropic', model: 'claude-haiku-4-5',
    modelSource: 'dispatch', status: 200, viaRelay: true, leg: 'relay', upstreamHost: 'relay.mirasim.ai',
    providerCallId: 'pd1', input: 1_000_000, output: 0,
  }), 0);
  assert.ok(led.familyIds().includes('dispatch'));
  assert.ok(Math.abs(led.familySpent((MIN - 1) * 60, (MIN + 1) * 60, 'dispatch', { includeOpenMinute: true }) - 1) < 1e-9, 'haiku $1/M');
});

test('the enabled-model roster is checked against the price list', () => {
  const file = join(tmp, 'setting.json');
  writeFileSync(file, JSON.stringify({ enabledModels: { claude: ['claude-opus-5[1m]'], kimi: ['kimi-k3'], codex: [] } }));
  const r = readEnabledModels(new Pricing(join(tmp, 'no-cache.json')), file);
  assert.deepEqual(r.models, ['claude-opus-5[1m]', 'kimi-k3']);
  assert.deepEqual(r.unpriced, ['kimi-k3']);
  assert.equal(readEnabledModels(new Pricing(join(tmp, 'no-cache.json')), join(tmp, 'missing.json')), null);
});

test('a machine ships its own speed snapshot so the other end can look at it', async (t) => {
  const hub = await startHub(t);
  const T = Math.floor(Date.now() / 1000) - 120;   // 靠近现在：hub 会把过保留期的分片清掉
  const ledgerA = ledgerWith('spd-a', { buckets: {} });
  const ledgerB = ledgerWith('spd-b', { buckets: {} });
  const syncA = new LedgerSync({ configFile: syncConfig('spd-a', hub.base), machineId: 'spd-a', installId: '1111222233334444' });
  const syncB = new LedgerSync({ configFile: syncConfig('spd-b', hub.base), machineId: 'spd-b', installId: '5555666677778888' });

  const speed = { rows: [{ model: 'Opus 5', modelId: 'claude-opus-5', rate: 36, ttft: 2.4, endToEnd: 20, samples: 5, latestAt: T - 60, tasks: [] }], sampleTotal: 5 };
  await syncB.run(ledgerB, T, { speed });
  const ra = await syncA.run(ledgerA, T + 1);

  // 分片带着速度过来，机器行上直接可读——界面据此给「看这台」的入口
  const row = ra.machines.find((m) => m.id === 'spd-b');
  assert.equal(row.speed.rows[0].model, 'Opus 5');
  assert.equal(row.speed.rows[0].rate, 36);
  // 本机那行不带 speed：本机速度走 payload.speed，重复一份只会撑大 payload
  assert.equal(ra.machines.find((m) => m.self).speed, undefined);
  // 合并口径不受影响：speed 不是账本，一个字节都不该进 spent
  ledgerA.adoptForeignShards(ra.shards);
  assert.equal(ledgerA.spent(T - 600, T + 600), 0);

  // 没上报速度的机器（轻客户端、老版本）不出现该字段，界面就不给入口
  await syncB.run(ledgerB, T + 700);
  const ra2 = await syncA.run(ledgerA, T + 701);
  assert.equal(ra2.machines.find((m) => m.id === 'spd-b').speed, undefined);
});

test('deploy-linux keeps an existing sync.json and no longer knows GitHub at all', () => {
  // 脚本头一直承诺「重复跑不动 sync.json」，但从前 git 通道那段无条件盖写——服务器上真配着
  // hub 通道（本脚本不认识的一种），盖成 git 通道等于把它从现有面板上踢下来。2026-09-23 实咬，
  // 改成默认不动 + --reset-sync 显式换。
  //
  // 同一天用户拍了「不要存 GitHub」（每台机器每 10 分钟要提交 333 KB ≈ 47 MB/天，还要一把 gh
  // 装的部署密钥），于是 git 通道连代码一起删了：这个脚本里不该再出现 gh、部署密钥或 remote。
  const src = readFileSync(new URL('../scripts/deploy-linux.mjs', import.meta.url), 'utf8');
  assert.match(src, /const keepSync = hasSync && !flag\('reset-sync'\)/);
  assert.match(src, /if \(keepSync\) \{/, '已有配置那段必须最先判，否则就是无条件盖写');
  assert.match(src, /else if \(wantHub\) \{/, 'hub 是推荐通道');
  assert.doesNotMatch(src, /--via-git|gh api|DEFAULT_REMOTE|ssh-keygen/, 'git 通道的代码痕迹要清干净（注释里提历史可以）');
});
