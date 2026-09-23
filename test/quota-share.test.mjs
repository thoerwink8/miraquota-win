/**
 * 账号额度随分片同步：本机 Mirasim 没在跑时，额度来自还在跑的那台机器。
 * 额度点是账号级的（同一个 userId 的所有设备共用一个池），所以这不是估算，
 * 是同一份数字换个人读——见 docs/MULTI-MACHINE.md。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostLedger, STATE_SCHEMA } from '../provider/lib/ledger.mjs';
import { LedgerSync } from '../provider/lib/ledger-sync.mjs';
import { Engine } from '../provider/lib/engine.mjs';
import { anchorsFrom } from '../provider/lib/anchors.mjs';
import { startHub, hubConfig } from './helpers/hub-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-quota-'));

/** 写一份指向该 hub 的 sync.json，返回路径（远端是本地 hub，不依赖网络）。 */
const syncConfig = (name, base, extra = {}) => hubConfig(name, base, { extra: { intervalSec: 600, ...extra } });

function emptyLedger(name) {
  const file = join(tmp, `${name}-ledger.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: STATE_SCHEMA }));
  return new CostLedger({}, file);
}

/** 本机锚点不可用/可用的替身：AnchorStore 认死 ~/.miraquota，测试不碰真机状态。 */
const anchorStub = (capturedAt = 0, anchors = []) => ({ anchors, capturedAt, get usable() { return anchors.length > 0; }, update() {} });

// 时间锚在现在附近：分片经 hub 走时，过保留期的会被读时清掉（1970 年的时间戳等于当场丢）。
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

test('a machine ships the account quota so the offline one need not guess it', async (t) => {
  const hub = await startHub(t);
  const syncB = new LedgerSync({
    configFile: syncConfig('q-b', hub.base),
    machineId: 'q-b', installId: 'bbbbbbbbbbbbbbbb',
  });
  const syncA = new LedgerSync({
    configFile: syncConfig('q-a', hub.base),
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

test('the offline machine reckons from the running one, and says whose number it is', async (t) => {
  const hub = await startHub(t);
  const syncB = new LedgerSync({
    configFile: syncConfig('e-b', hub.base),
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
    // 全部状态路径都注入：这条测试会跑 poll()，而 poll 会 refresh 账本、settle 归因——
    // 用默认路径就是去改真机的 ~/.miraquota（2026-09-23 实咬：正好撞上账本升 schema，
    // 把用户的 ledger.json 就地迁移重写了）。
    ledgerFile: join(tmp, 'e-a-ledger.json'),
    anchorFile: join(tmp, 'e-a-anchor.json'),
    settingsFile: join(tmp, 'e-a-settings.json'),
    attribFile: join(tmp, 'e-a-attrib.json'),
    calibratorFile: join(tmp, 'e-a-calibration.json'),
    syncOpts: {
      configFile: syncConfig('e-a', hub.base),
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
      // installFile 也得给：LedgerSync 构造函数里就会读/生成安装 id 并落盘，
      // 漏了它这条测试第一次跑就是这么红起来的（假 HOME 里冒出 .miraquota/install.json）。
      syncOpts: { configFile: join(w, 'none.json'), repoDir: join(w, 'repo'), installFile: join(w, 'install.json') },
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
  const cfg = syncConfig('cadence', 'http://127.0.0.1:1');   // 只读配置，不发请求
  const s = new LedgerSync({ configFile: cfg, machineId: 'c' });
  assert.equal(s.intervalSec, 600);
  assert.equal(s.quotaIntervalSec, 120, '账本可以迟到，额度不行——它是对面唯一的额度来源');

  const slow = new LedgerSync({
    configFile: syncConfig('cadence-slow', 'http://127.0.0.1:1', { quotaIntervalSec: 300 }),
    machineId: 'c2',
  });
  assert.equal(slow.quotaIntervalSec, 300, 'sync.json 说了算');

  // 配得比常规轮还慢是配错了，快节奏不该反过来拖慢同步
  const tight = new LedgerSync({
    configFile: syncConfig('cadence-tight', 'http://127.0.0.1:1', { quotaIntervalSec: 9999 }),
    machineId: 'c3',
  });
  assert.equal(tight.quotaIntervalSec, 600);
});
