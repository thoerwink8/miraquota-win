import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostLedger } from '../provider/lib/ledger.mjs';
import { LedgerSync, cleanMachineId } from '../provider/lib/ledger-sync.mjs';
import { Calibrator } from '../provider/lib/calibrator.mjs';
import { PointsAttributor } from '../provider/lib/points-attrib.mjs';
import { Engine } from '../provider/lib/engine.mjs';

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
  assert.deepEqual(ra.machines, [
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

test('a broken remote is reported in status without throwing', async () => {
  const sync = new LedgerSync({
    configFile: syncConfig('broken', join(tmp, 'no-such-remote.git')),
    repoDir: join(tmp, 'broken-repo'),
    machineId: 'broken',
  });
  const fake = { exportShard: (id, now) => ({ schemaVersion: 1, machineId: id, generatedAt: now, coverage: { fromSec: 0, toSec: now }, buckets: {}, scoped: {}, family: {} }) };
  const r = await sync.run(fake, 1000);
  assert.ok(r.error);                // 失败进状态字段
  assert.equal(r.state, 'error');    // 有 error ⇒ 故障态（UI 红）
  // 不抛异常、不阻断；push 没成功 ⇒ 本机尚无成功发布时刻
  assert.deepEqual(r.machines, [{ id: 'broken', lastShardSec: null, self: true }]);
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
  assert.deepEqual(engine.payload().sync, {
    state: 'connecting',
    intervalSec: 600,
    machines: [{ id: 'engine', lastShardSec: null, self: true }],
  });
});
