import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostLedger } from '../provider/lib/ledger.mjs';
import { LedgerSync, cleanMachineId, retryOnce, explainSyncError } from '../provider/lib/ledger-sync.mjs';
import { Calibrator } from '../provider/lib/calibrator.mjs';
import { PointsAttributor } from '../provider/lib/points-attrib.mjs';
import { readEnabledModels, Engine } from '../provider/lib/engine.mjs';
import { Pricing } from '../provider/lib/pricing.mjs';

// 全部状态走注入的临时目录，不碰 ~/.miraquota；远端是本地 bare 仓，不依赖网络。
const tmp = mkdtempSync(join(tmpdir(), 'mq-multi-'));

const git = (...args) => new Promise((resolve, reject) => {
  execFile('git', args, { timeout: 30_000, windowsHide: true },
    (err, stdout, stderr) => err ? reject(new Error(String(stderr || err))) : resolve(String(stdout)));
});

/** 写一份 sync.json，返回路径。 */
function syncConfig(name, remote, intervalSec = 600) {
  const file = join(tmp, `${name}-sync.json`);
  writeFileSync(file, JSON.stringify({ remote, intervalSec }));
  return file;
}

/** 预置聚合态的账本（pricing 不参与查询，传空对象即可）。 */
/** 带真价目表（内置官方价、无缓存）的空账本——测网关行解析要用到 pricing.cost */
function pricedLedger(name) {
  const file = join(tmp, `${name}-ledger.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: 2 }));
  return new CostLedger(new Pricing(join(tmp, 'no-cache.json')), file);
}

/** 机器行去掉收件口身份字段（key/account），老测试只比 id/时间/本机标记 */
const bare = (rows) => rows.map(({ id, lastShardSec, self }) => ({ id, lastShardSec, self }));

function ledgerWith(name, data) {
  const file = join(tmp, `${name}-ledger.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: 2, ...data }));
  return new CostLedger({}, file);
}

test('machine ids are cleaned into branch-safe short names', () => {
  assert.equal(cleanMachineId('DESKTOP-A1B2.local'), 'desktop-a1b2-local');
  assert.equal(cleanMachineId('__'), 'machine');
});

test('two machines publish shards over a bare git remote and read each other', async () => {
  const remote = join(tmp, 'remote.git');
  await git('init', '--bare', '--quiet', remote);

  const T = 1_000_000;
  const MIN = Math.floor(T / 60) - 5;   // 桶分钟取 T 附近，避免被任何窗口逻辑边界干扰
  const ledgerA = ledgerWith('alpha', {
    buckets: { [MIN]: 2 },
    family: { [`claude|${MIN}`]: 2 },
  });
  const ledgerB = ledgerWith('beta', {
    buckets: { [MIN]: 3, [MIN + 1]: 5 },
    family: { [`claude|${MIN + 1}`]: 5, [`gpt|${MIN + 1}`]: 1 },
  });
  const syncA = new LedgerSync({ configFile: syncConfig('alpha', remote), repoDir: join(tmp, 'alpha-repo'), machineId: 'alpha' });
  const syncB = new LedgerSync({ configFile: syncConfig('beta', remote), repoDir: join(tmp, 'beta-repo'), machineId: 'beta' });

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

  // 单提交覆盖：A 连续发布两次后，远端 machine/alpha 仍只有 1 个提交
  await syncA.run(ledgerA, T + 700);
  assert.equal((await git('-C', remote, 'rev-list', '--count', 'machine/alpha')).trim(), '1');
  assert.equal((await git('-C', remote, 'rev-list', '--count', 'machine/beta')).trim(), '1');
});

/** 只需要 exportShard 的假账本。 */
const fakeLedger = () => ({
  exportShard: (id, now) => ({
    schemaVersion: 1, machineId: id, generatedAt: now,
    coverage: { fromSec: 0, toSec: now }, buckets: {}, scoped: {}, family: {},
  }),
});

test('a broken remote is reported in status without throwing, and one failure is not red yet', async () => {
  const sync = new LedgerSync({
    configFile: syncConfig('broken', join(tmp, 'no-such-remote.git')),
    repoDir: join(tmp, 'broken-repo'),
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

test('publish succeeding while fetch fails is a middle state, never red', async () => {
  // 真链路制造「发上去了、读不回来」：origin.url 指向不存在的路径（fetch 用它 ⇒ 失败），
  // pushurl 指向真 bare 仓（push 用它 ⇒ 成功）。#ensureRepo 只校准 url，不碰 pushurl。
  const good = join(tmp, 'half-good.git');
  await git('init', '--bare', '--quiet', good);
  const bad = join(tmp, 'half-missing.git');
  const repoDir = join(tmp, 'half-repo');
  await git('init', '--quiet', repoDir);
  await git('-C', repoDir, 'remote', 'add', 'origin', bad);
  await git('-C', repoDir, 'remote', 'set-url', '--push', 'origin', good);

  const T = 3_000_000;
  const sync = new LedgerSync({
    configFile: syncConfig('half', bad), repoDir, machineId: 'half', retryDelayMs: 5,
  });
  const r = await sync.run(fakeLedger(), T);
  assert.equal(r.pushOk, true);       // 本机分片确实上传了
  assert.ok(r.error);                 // 读取失败仍记原因
  assert.equal(r.state, 'warn');      // 但不是整体失败（UI 黄，不是红）
  assert.deepEqual(bare(r.machines), [{ id: 'half', lastShardSec: T, self: true }]);
  assert.equal((await git('-C', good, 'rev-list', '--count', 'machine/half')).trim(), '1');

  // 连续多轮只有读取失败也不报红——本机数据没丢，只是合并样本少
  const r2 = await sync.run(fakeLedger(), T + 600);
  assert.equal(r2.state, 'warn');
  assert.equal(r2.failStreak, 2);
});

test('a flaky first attempt is retried inside the round and does not count as a failure', async () => {
  // 实测本地代理偶发 SSL_ERROR_SYSCALL、紧接着的六次访问全部成功。
  // 用远端 pre-receive 钩子复现：第一次 push 必被拒（并吐同一句报错），第二次即通过。
  const remote = join(tmp, 'flaky-remote.git');
  await git('init', '--bare', '--quiet', remote);
  writeFileSync(join(remote, 'hooks', 'pre-receive'), [
    '#!/bin/sh',
    'if [ -f flaked ]; then exit 0; fi',
    'touch flaked',
    'echo "OpenSSL SSL_read: SSL_ERROR_SYSCALL" >&2',
    'exit 1',
    '',
  ].join('\n'));

  const sync = new LedgerSync({
    configFile: syncConfig('flaky', remote), repoDir: join(tmp, 'flaky-repo'),
    machineId: 'flaky', retryDelayMs: 50,
  });
  const r = await sync.run(fakeLedger(), 4_000_000);
  assert.ok(existsSync(join(remote, 'flaked')));   // 第一次真的被拒了
  assert.equal(r.error, undefined);                // 抖动被单轮内重试吃掉
  assert.equal(r.state, 'ok');
  assert.equal(r.failStreak, undefined);
  assert.equal((await git('-C', remote, 'rev-list', '--count', 'machine/flaky')).trim(), '1');
});

test('retryOnce runs the second attempt and reports the latest reason when both fail', async () => {
  let n = 0;
  assert.equal(await retryOnce(async () => { if (++n === 1) throw new Error('抖一下'); return 'ok'; }, 5), 'ok');
  assert.equal(n, 2);
  await assert.rejects(retryOnce(async () => { throw new Error(`第 ${++n} 次`); }, 5), /第 4 次/);
});

test('common git failures get a plain-language reading, unknown ones stay raw', () => {
  // 人话归纳只是导读，原文另存 sync.error（UI 当次要小字），归纳不出来时返回 null
  assert.equal(explainSyncError("fatal: unable to access 'https://github.com/x/y.git/': OpenSSL SSL_read: SSL_ERROR_SYSCALL"),
    '网络连不上（代理或网络问题）');
  assert.equal(explainSyncError('fatal: unable to access: Could not resolve host: github.com'),
    '网络连不上（代理或网络问题）');
  assert.equal(explainSyncError('fatal: Authentication failed for https://github.com/x/y.git/'),
    '凭据无效或无权限');
  // 权限类常同时含 unable to access，必须判成权限而不是网络
  assert.equal(explainSyncError("remote: Permission to x/y.git denied\nfatal: unable to access ...: The requested URL returned error: 403"),
    '凭据无效或无权限');
  assert.equal(explainSyncError("remote: Repository not found."), '仓库/收件口地址不对或已不存在');
  assert.equal(explainSyncError('fatal: 某个没见过的毛病'), null);
});

test('repo-level identity and signing config are re-applied every round, not only on init', async () => {
  // 实测缺陷：首次 init 后进程提前退出，三项 config 没落盘，之后每轮都以「.git 已存在」跳过补写，
  // 永久缺失 ⇒ 提交署用户全局身份、开了 GPG 签名则 commit 直接失败。
  const remote = join(tmp, 'cfg-remote.git');
  await git('init', '--bare', '--quiet', remote);
  const repoDir = join(tmp, 'cfg-repo');
  await git('init', '--quiet', repoDir);   // 只有 .git，三项 config 都没有
  const readCfg = (k) => git('-C', repoDir, 'config', '--local', '--get', k).then((s) => s.trim(), () => null);
  assert.equal(await readCfg('user.name'), null);

  const sync = new LedgerSync({
    configFile: syncConfig('cfg', remote), repoDir, machineId: 'cfg', retryDelayMs: 5,
  });
  const r = await sync.run(fakeLedger(), 5_000_000);
  assert.equal(r.error, undefined);
  assert.equal(await readCfg('user.name'), 'miraquota');
  assert.equal(await readCfg('user.email'), 'miraquota@local');
  assert.equal(await readCfg('commit.gpgsign'), 'false');
});

test('sync state machine: connecting before first success, ok while fresh, stale falls back', async () => {
  const remote = join(tmp, 'state-remote.git');
  await git('init', '--bare', '--quiet', remote);
  const T = 2_000_000;
  const a = new LedgerSync({ configFile: syncConfig('sa', remote), repoDir: join(tmp, 'sa-repo'), machineId: 'sa' });
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

test('without sync.json the feature is fully off: no repo, no payload field', async () => {
  const missing = join(tmp, 'no-such-sync.json');
  const repoDir = join(tmp, 'off-repo');
  const off = new LedgerSync({ configFile: missing, repoDir, machineId: 'off' });
  assert.equal(off.enabled, false);
  assert.equal(await off.run(ledgerWith('off', { buckets: {} })), null);
  assert.ok(!existsSync(repoDir));   // 未配置时绝不创建同步仓

  const engine = new Engine({ forceOffline: true, syncOpts: { configFile: missing, repoDir } });
  assert.ok(!('sync' in engine.payload()));
});

test('with sync configured the payload carries a sync status field', () => {
  const engine = new Engine({
    forceOffline: true,
    syncOpts: {
      configFile: syncConfig('engine', join(tmp, 'unused-remote.git')),
      repoDir: join(tmp, 'engine-repo'),
      machineId: 'engine',
    },
  });
  // 只比同步状态本身：这个 Engine 读的是真机的账本与锚点（非隔离），
  // 用量字段会随本机数据变，deepEqual 整块会被无关字段带崩。
  const { usage, ...status } = engine.payload().sync;
  assert.deepEqual({ ...status, machines: bare(status.machines) }, {
    state: 'connecting',
    mode: 'git',
    pushOk: false,
    intervalSec: 600,
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

test('a cold start uses the shards fetched by the previous round, before any network', async () => {
  // 实测踩过：进程启动到第一轮同步跑完之前只认本机账本，美元与标定按单机口径给，
  // 而他机分片就躺在本地 sync-repo 里（--once 更是活不到第一轮同步完成）。
  const remote = join(tmp, 'cold.git');
  await git('init', '--bare', '--quiet', remote);
  const a = new LedgerSync({
    configFile: syncConfig('cold-a', remote), repoDir: join(tmp, 'cold-a-repo'), machineId: 'a',
  });
  const b = new LedgerSync({
    configFile: syncConfig('cold-b', remote), repoDir: join(tmp, 'cold-b-repo'), machineId: 'b',
  });
  await a.run(ledgerWith('cold-a', { minutes: { 29000000: { usd: 3 } } }), 29000000 * 60);
  await b.run(ledgerWith('cold-b', { minutes: {} }), 29000000 * 60);
  assert.equal(b.shards.length, 1, 'b 这一轮应读到 a 的分片');

  // 新进程：不跑 run()，只装缓存——拿到的仍是 a 的分片
  const bRestarted = new LedgerSync({
    configFile: syncConfig('cold-b2', remote), repoDir: join(tmp, 'cold-b-repo'), machineId: 'b',
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
