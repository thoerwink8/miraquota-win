import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PointsAttributor } from '../provider/lib/points-attrib.mjs';

// 每个用例独立状态文件，互不污染，也不碰 ~/.miraquota 真实状态。
const dir = mkdtempSync(join(tmpdir(), 'mq-attrib-'));
let n = 0;
const fresh = () => new PointsAttributor(join(dir, `state-${n++}.json`));

/** 假账本：家族 → [{from,to,usd}] 区间支出。 */
function fakeLedger(spend) {
  return {
    familyIds: () => Object.keys(spend),
    familySpent: (from, to, id) => (spend[id] ?? [])
      .filter((s) => s.from >= from && s.to <= to)
      .reduce((a, s) => a + s.usd, 0),
  };
}

const W = (used, resetAt = 9999999) => [{ label: '5h', used, budget: 100000, resetAt, modelScoped: false }];

test('points deltas split across families by ledger share after settling', () => {
  const a = fresh();
  a.record(W(1000), 1000);
  a.record(W(1300), 1060);   // +300 点，区间 [1000,1060]
  const ledger = fakeLedger({
    claude: [{ from: 1000, to: 1060, usd: 2 }],
    gpt: [{ from: 1000, to: 1060, usd: 1 }],
  });
  a.settle(ledger, 1060 + 300);   // 静置期满
  assert.ok(Math.abs(a.familyPoints(0, 999999, 'claude') - 200) < 1e-6);
  assert.ok(Math.abs(a.familyPoints(0, 999999, 'gpt') - 100) < 1e-6);
  assert.equal(a.unattributedPoints(0, 999999), 0);
});

test('deltas with no ledger spend land in the unattributed bucket', () => {
  const a = fresh();
  a.record(W(0), 2000);
  a.record(W(50), 2060);
  a.settle(fakeLedger({}), 2060 + 300);
  assert.equal(a.unattributedPoints(0, 999999), 50);
});

test('a window reset only re-arms the baseline and books nothing', () => {
  const a = fresh();
  a.record(W(90000, 5000), 3000);
  a.record(W(100, 99999), 3060);   // resetAt 变了：不产增量
  a.settle(fakeLedger({ claude: [{ from: 3000, to: 3060, usd: 1 }] }), 3060 + 300);
  assert.equal(a.familyPoints(0, 999999, 'claude'), 0);
  a.record(W(400, 99999), 3120);   // 重置后的正常增量照常归因
  a.settle(fakeLedger({ claude: [{ from: 3060, to: 3120, usd: 1 }] }), 3120 + 300);
  assert.ok(Math.abs(a.familyPoints(0, 999999, 'claude') - 300) < 1e-6);
});

test('pending deltas wait out the relay backfill settle window', () => {
  const a = fresh();
  a.record(W(0), 4000);
  a.record(W(10), 4060);
  const ledger = fakeLedger({ claude: [{ from: 4000, to: 4060, usd: 1 }] });
  a.settle(ledger, 4090);          // 静置未满：不入桶
  assert.equal(a.familyPoints(0, 999999, 'claude'), 0);
  a.settle(ledger, 4060 + 301);    // 满了才分摊
  assert.ok(Math.abs(a.familyPoints(0, 999999, 'claude') - 10) < 1e-6);
});
