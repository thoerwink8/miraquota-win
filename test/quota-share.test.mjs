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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostLedger, STATE_SCHEMA } from '../provider/lib/ledger.mjs';
import { LedgerSync } from '../provider/lib/ledger-sync.mjs';
import { Engine } from '../provider/lib/engine.mjs';
import { anchorsFrom } from '../provider/lib/anchors.mjs';
import { fakeInbox, inboxConfig } from './helpers/inbox-fixture.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-quota-'));

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
  const e2 = new Engine({
    forceOffline: true,
    home: join(tmp, 'read-home'),
    ledgerFile: join(tmp, 'read-ledger.json'), anchorFile: join(tmp, 'read-anchor.json'),
    settingsFile: join(tmp, 'read-settings.json'), attribFile: join(tmp, 'read-attrib.json'),
    calibratorFile: join(tmp, 'read-calibration.json'),
    syncOpts: { configFile: join(tmp, 'none.json'), installId: '7d7d7d7d7d7d7d7d' },
  });
  e2.ledger.adoptForeignShards(r.shards);
  assert.equal(e2.payload().state, 'local', '别人分片里的额度不当锚点：本机没实读、没锚点，就是无数据');
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
