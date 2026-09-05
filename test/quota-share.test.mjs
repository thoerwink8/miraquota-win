/**
 * 账号额度随分片同步：本机 Mirasim 没在跑时，额度来自还在跑的那台机器。
 * 额度点是账号级的（同一个 userId 的所有设备共用一个池），所以这不是估算，
 * 是同一份数字换个人读——见 docs/MULTI-MACHINE.md。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostLedger } from '../provider/lib/ledger.mjs';
import { LedgerSync } from '../provider/lib/ledger-sync.mjs';
import { Engine } from '../provider/lib/engine.mjs';
import { anchorsFrom } from '../provider/lib/anchors.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-quota-'));

const git = (...args) => new Promise((resolve, reject) => {
  execFile('git', args, { timeout: 30_000, windowsHide: true },
    (err, stdout, stderr) => err ? reject(new Error(String(stderr || err))) : resolve(String(stdout)));
});

function syncConfig(name, remote, extra = {}) {
  const file = join(tmp, `${name}-sync.json`);
  writeFileSync(file, JSON.stringify({ remote, intervalSec: 600, ...extra }));
  return file;
}

function emptyLedger(name) {
  const file = join(tmp, `${name}-ledger.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: 2 }));
  return new CostLedger({}, file);
}

/** 本机锚点不可用/可用的替身：AnchorStore 认死 ~/.miraquota，测试不碰真机状态。 */
const anchorStub = (capturedAt = 0, anchors = []) => ({ anchors, capturedAt, get usable() { return anchors.length > 0; }, update() {} });

const NOW = 3_000_000;
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

test('a machine ships the account quota so the offline one need not guess it', async () => {
  const remote = join(tmp, 'quota-remote.git');
  await git('init', '--bare', '--quiet', remote);
  const syncB = new LedgerSync({
    configFile: syncConfig('q-b', remote), repoDir: join(tmp, 'q-b-repo'),
    machineId: 'q-b', installId: 'bbbbbbbbbbbbbbbb',
  });
  const syncA = new LedgerSync({
    configFile: syncConfig('q-a', remote), repoDir: join(tmp, 'q-a-repo'),
    machineId: 'q-a', installId: 'aaaaaaaaaaaaaaaa', inboxUrl: null,
  });

  await syncB.run(emptyLedger('q-b'), NOW, { limits: LIMITS });
  const ra = await syncA.run(emptyLedger('q-a'), NOW + 1);

  const shard = ra.shards.find((s) => s.machineId === 'q-b');
  assert.equal(shard.limits.capturedAt, LIMITS.capturedAt, '采集时刻要原样过来——对面据此判龄期');
  assert.equal(shard.limits.windows.find((w) => w.label === '7d').budget, 613_800);
  // 分片格式没变：老版本读到多出来的字段直接忽略
  assert.equal(shard.schemaVersion, 1);
});

test('the offline machine reckons from the running one, and says whose number it is', async () => {
  const remote = join(tmp, 'engine-remote.git');
  await git('init', '--bare', '--quiet', remote);
  const syncB = new LedgerSync({
    configFile: syncConfig('e-b', remote), repoDir: join(tmp, 'e-b-repo'),
    machineId: 'vmi-server', installId: 'bbbbbbbbbbbbbbbb',
  });
  const now = Date.now() / 1000;
  const limits = {
    capturedAt: now - 90,
    windows: [{ label: '7d', used: 494_270, budget: 613_800, resetAt: now + 200_000 }],
  };
  await syncB.run(emptyLedger('e-b'), now, { limits });

  const engine = new Engine({
    forceOffline: true,
    syncOpts: {
      configFile: syncConfig('e-a', remote), repoDir: join(tmp, 'e-a-repo'),
      machineId: 'e-a', installId: 'aaaaaaaaaaaaaaaa', inboxUrl: null,
      cacheFile: join(tmp, 'e-a-cache.json'),
    },
  });
  engine.anchors = anchorStub();          // 本机从没连上过 Mirasim
  await engine.poll();
  for (let i = 0; i < 200 && !engine.foreignLimits; i++) await new Promise((r) => setTimeout(r, 50));

  assert.ok(engine.foreignLimits, '一轮同步就该把账号额度带回来');
  const p = engine.payload();
  assert.equal(p.state, 'reckoned');
  const w = p.windows.find((x) => x.label === '7d');
  // 满额是官方口径的除法，不是标定推断——这正是「总额度随时同步」要的那个数
  assert.equal(w.fullUSD, 613_800 * 0.01);
  assert.ok(w.usedPercent >= 494_270 / 613_800 * 100, '基线是他机读到的账号百分比，只增不减');
  assert.equal(p.reckonFrom.machineId, 'vmi-server');
  assert.ok(p.reckonFrom.ageSeconds >= 90 && p.reckonFrom.ageSeconds < 900);
  assert.match(p.detail, /vmi-server/);
  assert.match(p.detail, /他人占用已计到那一刻/);
  assert.doesNotMatch(p.detail, /他人占用不可见/, '账号级数字里别人的占用是算进去的，别照抄单机文案');
});

test('a fresher local anchor still wins: freshness is the only rule', () => {
  const engine = new Engine({ forceOffline: true, syncOpts: { configFile: join(tmp, 'none.json') } });
  const now = Date.now() / 1000;
  engine.foreignLimits = { capturedAt: now - 600, windows: LIMITS.windows, machineId: 'vmi-server', account: null };

  engine.anchors = anchorStub(now - 60, anchorsFrom(LIMITS.windows, now - 60));
  assert.equal(engine.payload().reckonFrom, undefined, '本机锚点更新时用本机的');
  assert.match(engine.payload().detail, /他人占用不可见/);

  engine.anchors = anchorStub(now - 1800, anchorsFrom(LIMITS.windows, now - 1800));
  assert.equal(engine.payload().reckonFrom.machineId, 'vmi-server', '本机锚点更旧时用他机的');

  // 太老的他机快照不如本机锚点，两边都过期就退回本机那条老路
  engine.foreignLimits = { capturedAt: now - 40 * 86400, windows: LIMITS.windows, machineId: 'vmi-server' };
  engine.anchors = anchorStub();
  assert.equal(engine.payload().state, 'local');
});

test('the quota-bearing rounds run on their own faster clock', () => {
  const cfg = syncConfig('cadence', join(tmp, 'unused.git'));
  const s = new LedgerSync({ configFile: cfg, repoDir: join(tmp, 'cadence-repo'), machineId: 'c' });
  assert.equal(s.intervalSec, 600);
  assert.equal(s.quotaIntervalSec, 120, '账本可以迟到，额度不行——它是对面唯一的额度来源');

  const slow = new LedgerSync({
    configFile: syncConfig('cadence-slow', join(tmp, 'unused.git'), { quotaIntervalSec: 300 }),
    repoDir: join(tmp, 'cadence-slow-repo'), machineId: 'c2',
  });
  assert.equal(slow.quotaIntervalSec, 300, 'sync.json 说了算');

  // 配得比常规轮还慢是配错了，快节奏不该反过来拖慢同步
  const tight = new LedgerSync({
    configFile: syncConfig('cadence-tight', join(tmp, 'unused.git'), { quotaIntervalSec: 9999 }),
    repoDir: join(tmp, 'cadence-tight-repo'), machineId: 'c3',
  });
  assert.equal(tight.quotaIntervalSec, 600);
});
