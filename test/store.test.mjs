/**
 * 账本存储（SQLite 流水账）的契约测试。
 *
 * 这一层要钉住的是"换口径不再需要重建"这件事——旧账本栽在把聚合态当账本存，改一次口径就得
 * 清空重扫 8 天（schema 3 那次）。所以测试的重点不是 SQL 本身，而是：
 *   1. 流水是唯一真相：两份来源都留着、各自打标，**没有任何一条记录在写入时被丢掉**；
 *   2. 口径是视图：四种口径在同一份数据上给出四个数，切换不动一个字节；
 *   3. 去重靠主键：重读同一个文件是幂等的，且"同一响应多行"取较大值；
 *   4. 保留：先汇总后删，明细删掉后 hourly 汇总还能出同样的数（顺序反了就永久丢数）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UsageStore, STORE_SCHEMA } from '../provider/lib/store.mjs';
import { callRow, gatewayLine, transcriptLine, turnLine } from '../provider/lib/sources.mjs';
import { Pricing } from '../provider/lib/pricing.mjs';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'mq-store-'));
let n = 0;
const pricing = () => new Pricing(join(tmp, 'no-cache.json'));
const fresh = (opts = {}) => new UsageStore({ file: join(tmp, `s${n++}.db`), ...opts });

const HOUR = 3600;
const T0 = Math.floor(new Date('2026-09-20T10:00:00Z').getTime() / 1000);

/** transcript 行（fable $10/M 输入 → 100 万输入 token = $10）。 */
const tRow = (at, model, tokens, key) => callRow({
  key: 't:' + key, src: 't', side: 't', ts: at, model,
  i: tokens, usd: tokens / 1e6 * (model.includes('fable') ? 10 : 5),
});

/** 网关行。 */
const gRow = (at, model, tokens, key) => callRow({
  key: 'g:' + key, src: 'g', side: 'g', ts: at, model,
  i: tokens, usd: tokens / 1e6 * (model.includes('fable') ? 10 : 5),
});

test('the journal keeps both sources; the basis is a view, not a copy of the data', () => {
  const s = fresh();
  // 同一小时同一模型：transcript 记了 $10，网关记了 $12（同一批调用的另一份记录）
  s.insertCalls([tRow(T0 + 60, 'claude-fable-5-1', 1_000_000, 'a'), gRow(T0 + 90, 'claude-fable-5-1', 1_200_000, 'b')]);
  const rows = s.db.prepare('SELECT COUNT(*) n FROM calls').get().n;
  assert.equal(rows, 2, '两份来源都留着，写入时不筛');

  s.basis = 't';
  assert.equal(s.spend(T0, T0 + HOUR).usd, 10);
  s.basis = 'g';
  assert.equal(s.spend(T0, T0 + HOUR).usd, 12);
  s.basis = 'union';
  assert.equal(s.spend(T0, T0 + HOUR).usd, 22, '并集就是旧的重复计');
  s.basis = 'max';
  assert.equal(s.spend(T0, T0 + HOUR).usd, 12, '取较大的那一侧：同一小时不相加');

  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM calls').get().n, 2, '换口径没动过数据一个字节');
  s.close();
});

test('max picks per machine, model and hour — never across them', () => {
  const s = fresh({ basis: 'max' });
  s.insertCalls([
    tRow(T0 + 60, 'claude-opus-5', 1_000_000, 'a1'),          // 这一小时 transcript 更全
    gRow(T0 + 60, 'claude-opus-5', 400_000, 'a2'),
    tRow(T0 + HOUR + 60, 'claude-opus-5', 200_000, 'b1'),     // 下一小时网关更全
    gRow(T0 + HOUR + 60, 'claude-opus-5', 900_000, 'b2'),
    tRow(T0 + 60, 'claude-fable-5-1', 100_000, 'c1'),         // 另一个模型各自比
    gRow(T0 + 60, 'claude-fable-5-1', 300_000, 'c2'),
  ]);
  // 5 + 4.5 + 3 = 12.5（逐小时逐模型取大）
  assert.ok(Math.abs(s.spend(T0, T0 + 2 * HOUR).usd - 12.5) < 1e-9);
  // 跨小时不许合并：把两小时各自的最大值加起来，而不是"整窗取大"
  assert.equal(s.byModel(T0, T0 + 2 * HOUR).length, 2);
  s.close();
});

test('re-reading the same file is idempotent, and a grown response takes the larger value', () => {
  const s = fresh();
  const line = JSON.stringify({
    timestamp: new Date((T0 + 60) * 1000).toISOString(), requestId: 'req_1',
    message: { model: 'claude-fable-5-1', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  });
  const p = pricing();
  const first = transcriptLine(line, { pricing: p });
  assert.equal(s.insertCalls([first]), 1);
  assert.equal(s.insertCalls([first]), 0, '同一行再来一次不算新行');
  // 同一次响应后续几行 usage 变大（Claude Code 把思考/正文分开写）
  const bigger = transcriptLine(JSON.stringify({
    timestamp: new Date((T0 + 61) * 1000).toISOString(), requestId: 'req_1',
    message: { model: 'claude-fable-5-1', usage: { input_tokens: 1_000_000, output_tokens: 500_000 } },
  }), { pricing: p });
  s.insertCalls([bigger]);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM calls').get().n, 1, '一个账目键只有一行');
  assert.ok(s.spend(T0, T0 + HOUR).usd > 10, '取的是较大值，不是先到的那份');
  s.close();
});

test('a non-billable call is kept in the journal but kept out of the money', () => {
  const s = fresh();
  s.insertCalls([
    { ...gRow(T0 + 60, 'claude-opus-5', 1_000_000, 'direct'), billable: 0 },
    gRow(T0 + 60, 'claude-opus-5', 1_000_000, 'relay'),
  ]);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM calls').get().n, 2, '没走 relay 的调用也留档（分析用）');
  assert.equal(s.spend(T0, T0 + HOUR).usd, 5, '但只有走 relay 的那笔算钱');
  s.close();
});

test('retention rolls up before deleting, so the hourly totals survive', () => {
  const s = fresh();
  s.insertCalls([
    tRow(Date.parse('2026-08-01T10:00:00Z') / 1000, 'claude-opus-5', 1_000_000, 'old1'),
    tRow(Date.parse('2026-08-01T11:00:00Z') / 1000, 'claude-opus-5', 1_000_000, 'old2'),
    tRow(T0 + 60, 'claude-opus-5', 1_000_000, 'new'),
  ]);
  const before = s.spend(0, Date.now() / 1000).usd;
  const r = s.prune({ beforeDay: '2026-09-01' });
  assert.equal(r.deleted, 2);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM calls').get().n, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM hourly').get().n, 2, '两小时合成两行小时汇总');
  const all = s.totalWithDaily(0, Date.now() / 1000);
  assert.ok(Math.abs(all.usd - before) < 1e-9, `明细删掉后总额不变：${all.usd} vs ${before}`);
  assert.ok(all.rolledUSD > 0 && all.liveUSD > 0);
  s.close();
});

test('turns attribute calls to tasks by time span, and the unattributed part is named', () => {
  const s = fresh();
  s.insertCalls([
    { ...tRow(T0 + 60, 'claude-fable-5-1', 1_000_000, 'in-task'), sid: 'sid-1' },
    tRow(T0 + 10 * HOUR, 'claude-fable-5-1', 1_000_000, 'no-task'),
  ]);
  s.insertTurns([{
    task: 'task-1', sid: 'sid-1', startedAt: T0, endedAt: T0 + HOUR, model: 'claude-fable-5-1',
  }]);
  const t = s.byTask(T0, T0 + 24 * HOUR);
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].task, 'task-1');
  assert.equal(t.rows[0].sid, 'sid-1');
  assert.ok(Math.abs(t.claimed - 10) < 1e-9);
  assert.ok(Math.abs(t.unclaimed - 10) < 1e-9, '归不上任务的那笔单独算，不摊到别的任务头上');
  s.close();
});

test('the reconciliation view says which side remembered more', () => {
  const s = fresh();
  s.insertCalls([
    tRow(T0 + 60, 'claude-fable-5-1', 1_000_000, 'a'),
    gRow(T0 + 60, 'claude-fable-5-1', 6_000_000, 'b'),
    gRow(T0 + 60, 'claude-opus-5', 1_000_000, 'c'),      // 只有网关有（不经 Claude Code）
  ]);
  const rows = s.reconcile(T0, T0 + HOUR);
  const fable = rows.find((r) => r.model === 'claude-fable-5-1');
  assert.ok(fable.gapWorthReporting, '网关记得多 ⇒ 要报');
  const opus = rows.find((r) => r.model === 'claude-opus-5');
  assert.equal(opus.t, 0);
  assert.ok(opus.gapWorthReporting);
  s.close();
});

test('an unpriced call is visible with its tokens instead of vanishing', () => {
  const s = fresh();
  s.insertCalls([{ ...tRow(T0 + 60, 'kimi-k9-unknown', 500_000, 'x'), usd: 0, priced: 0 }]);
  const rows = s.unpriced(T0, T0 + HOUR);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokens, 500_000);
  s.close();
});

test('pack produces a consistent single-file snapshot that inspect can vouch for', () => {
  const s = fresh();
  s.insertCalls([tRow(T0 + 60, 'claude-opus-5', 1_000_000, 'a')]);
  const target = join(tmp, 'packed.db');
  s.pack(target);
  assert.ok(existsSync(target) && statSync(target).size > 0);
  const info = UsageStore.inspect(target);
  assert.equal(info.integrity, 'ok');
  assert.equal(info.version, STORE_SCHEMA);
  assert.equal(info.calls, 1);
  // 快照能被当成一个新库打开，读数一致（迁 VPS 就是这一步）
  const reopened = new UsageStore({ file: target });
  assert.ok(Math.abs(reopened.spend(T0, T0 + HOUR).usd - 5) < 1e-9);
  reopened.close();
  s.close();
});

test('a newer schema refuses to be opened by an older build instead of guessing', () => {
  const s = fresh();
  s.close();
  const db = new DatabaseSync(join(tmp, `s${n - 1}.db`));
  db.exec('PRAGMA user_version = 99');
  db.close();
  assert.throws(() => fresh({ file: join(tmp, `s${n - 1}.db`) }), /schema/);
});

test('source parsers agree with what the old ledger booked', () => {
  const p = pricing();
  // transcript：一次响应多行、无 requestId 时退回 message.id
  const t = transcriptLine(JSON.stringify({
    timestamp: new Date(T0 * 1000).toISOString(), sessionId: 'sid-9', cwd: 'D:\\proj',
    message: { id: 'msg_1', model: 'claude-fable-5-1', usage: { input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000 } },
  }), { pricing: p });
  assert.equal(t.key, 't:msg_1');
  assert.equal(t.sid, 'sid-9');
  assert.equal(t.ws, 'D:\\proj');
  assert.equal(t.usd, 10 + 2 * 0.25, '缓存读按 fable-5-1 的 $0.25 算');
  assert.equal(t.family, 'claude');

  // 网关：dispatch 单独一边，不可计费的记 0
  const g = gatewayLine(JSON.stringify({
    id: 'sess:call', ts: new Date(T0 * 1000).toISOString(), sessionId: 'sess', agent: 'claude',
    provider: 'anthropic', model: 'claude-opus-5', status: 200, viaRelay: true, leg: 'relay',
    upstreamHost: 'relay.mirasim.ai', input: 1_000_000, workspace: 'D:\\proj', effort: 'high',
  }), { pricing: p });
  assert.equal(g.key, 'g:sess:call');
  assert.equal(g.billable, 1);
  assert.equal(g.effort, 'high');
  assert.equal(g.ws, 'D:\\proj');
  assert.equal(g.usd, 5);

  const d = gatewayLine(JSON.stringify({
    id: 'd:1', ts: new Date(T0 * 1000).toISOString(), model: 'claude-haiku-4-5', modelSource: 'dispatch',
    status: 200, viaRelay: true, leg: 'relay', upstreamHost: 'relay.mirasim.ai', input: 1_000_000,
  }), { pricing: p });
  assert.equal(d.src, 'd');
  assert.equal(d.side, 'g', 'dispatch 属于网关那一边');
  assert.equal(d.family, 'dispatch');

  // 轮次：只取归属信息
  const turn = turnLine(JSON.stringify({
    taskId: 'task-9', sessionId: 'sid-9', model: 'kimi-k3-high',
    startedAt: T0 * 1000, updatedAt: (T0 + 30) * 1000, usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 7 },
    prompt: '做一件事',
  }));
  assert.equal(turn.task, 'task-9');
  assert.equal(turn.endedAt, T0 + 30);
});
