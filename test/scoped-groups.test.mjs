/**
 * 档位分桶组的记忆：学会一次就记住，别再靠「这一轮读不到 limits」的运气。
 *
 * 为什么值得测：分钟桶只入一次，不会重扫。某一轮 scopedGroups 是空的，那一轮扫进来的
 * 钱就永久缺档位归属——fable 卡主行看着少了一截，没有任何报错（2026-09-08 实咬）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostLedger } from '../provider/lib/ledger.mjs';

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'mq-scoped-')), 'ledger.json');
const stub = { cost: () => 1 };

test('组落盘：重启后不必再等 limits 就已经会分桶', () => {
  const f = stateFile();
  new CostLedger(stub, f).adoptScopedGroups(['fable']);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).scopedGroups, ['fable']);
  assert.deepEqual(new CostLedger(stub, f).scopedGroups, ['fable']);
});

test('空集不覆盖：这一轮读不到 limits 不等于账号没有档位窗', () => {
  const f = stateFile();
  const a = new CostLedger(stub, f);
  a.adoptScopedGroups(['fable']);
  a.adoptScopedGroups([]);
  assert.deepEqual(a.scopedGroups, ['fable']);
  assert.deepEqual(new CostLedger(stub, f).scopedGroups, ['fable']);
});

test('组变了照样跟：新档位组覆盖旧的，起始分钟只给新来的记一次', () => {
  const led = new CostLedger(stub, stateFile());
  led.adoptScopedGroups(['fable']);
  const since = led.scopedSince.fable;
  led.adoptScopedGroups(['fable', 'ultra']);
  assert.deepEqual(led.scopedGroups, ['fable', 'ultra']);
  assert.equal(led.scopedSince.fable, since, 'fable 的起点不该被后来的一轮改写');
  assert.ok(led.scopedSince.ultra > 0);
});

test('重启后（且这一轮没有 limits）入桶仍带档位', () => {
  const f = stateFile();
  new CostLedger(stub, f).adoptScopedGroups(['fable']);
  const led = new CostLedger(stub, f);   // 重启，全程没有任何 limits 到达
  // 走原始行分片这条公开入桶路径（hub 给轻客户端定价用的同一段代码）
  const minute = 29814027;
  led.adoptForeignShards([{
    schemaVersion: 2, machineId: 'probe', installId: 'probe', generatedAt: minute * 60,
    coverage: { fromSec: minute * 60 - 60, toSec: minute * 60 },
    rows: [{ t: minute * 60, m: 'claude-fable-5', i: 10, o: 10 }],
  }]);
  const [shard] = led.foreignShards;
  assert.deepEqual(Object.keys(shard.scoped), [`fable|${minute}`],
    '组没记住的话这里是空的——总额有、档位没有，正是 fable 主行少一截的样子');
});
