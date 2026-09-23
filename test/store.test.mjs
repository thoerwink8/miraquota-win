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
import { mkdtempSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UsageStore, STORE_SCHEMA } from '../provider/lib/store.mjs';
import { callRow, gatewayLine, gatewayRows, transcriptLine, turnLine } from '../provider/lib/sources.mjs';
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

test('journalSince 出来的行必须能直接进 JSON（BigInt 进不去）', async () => {
  // 2026-09-23 上线时实咬：`kh` 是 63 位整数，读它必须开 setReadBigInts——但那是**整条语句
  // 级别**的开关，ts/i/o/… 会跟着一起变 BigInt，于是 `JSON.stringify` 抛
  // `Do not know how to serialize a BigInt`，流水一条都推不上去（VPS 日志里就这一行）。
  // hub 那条测试是直接 POST 行的（绕过了 journalSince），所以没拦住——这条专门盯它。
  const { JournalLedger } = await import('../provider/lib/journal-ledger.mjs');
  const led = new JournalLedger({ file: join(tmp, 'journal-since.db'), machine: 'm1' });
  led.store.insertCalls([{
    key: 'g|json-row', src: 'g', ts: T0, model: 'claude-opus-5', sid: 's1', ws: 'D:\\p',
    i: 10, o: 2, cr: 3, cw: 4, usd: 1.25, priced: true, billable: true, machine: 'm1',
  }]);
  const rows = led.journalSince(0);
  assert.equal(rows.length, 1);
  assert.equal(typeof rows[0].kh, 'string', 'kh 只能走字符串');
  assert.equal(typeof rows[0].ts, 'number', 'ts 必须是 number');
  assert.equal(typeof rows[0].i, 'number', 'token 计数同理');
  assert.doesNotThrow(() => JSON.stringify(rows), '这一批要能直接当请求体');
  assert.equal(JSON.parse(JSON.stringify(rows))[0].model, 'claude-opus-5');
  assert.equal(rows[rows.length - 1].ts, T0, '水位取最后一行，BigInt 会让 Math.floor 抛');
  led.close();
});

test('原始记录被改写时游标要发现并重扫——不然那一行永远是旧的', () => {
  // 2026-09-23 实咬：网关账本里同一行的 token 从 0 变成真值（先落一行、拿到 usage 再补全），
  // 而偏移游标早就越过它 → 那一行**永远读不到最终版本**：近 6 小时 1453 条带 token 的行里
  // 1451 条在库里是 0（3.4 亿 token 没记账），账号残差 $535 就是它。
  // 修法不是「别用游标」（性能），而是**校验游标**：改写会改变字节长度，游标前的指纹必然变。
  const dir = mkdtempSync(join(tmpdir(), 'mq-rewrite-'));
  const f = join(dir, 'usage-2026-09.ndjson');
  const line = (tok) => JSON.stringify({
    v: 1, id: 'call-1', ts: '2026-09-23T12:00:00.000Z', sessionId: 's1', agent: 'claude',
    model: 'claude-opus-5', viaRelay: true, leg: 'relay', status: 200,
    input: tok, output: 0, cacheRead: 0, cacheWrite: 0,
  });
  const pricing = new Pricing(join(tmp, 'no-cache.json'));
  writeFileSync(f, line(0) + '\n');

  const cursors = {};
  const first = [...gatewayRows({ dir, cutoff: 0, pricing, machine: 'm', cursors })];
  assert.equal(first.length, 1);
  assert.equal(first[0].i, 0, '第一轮读到的是「还没补全」的那一版');

  // 就地改写同一行：token 变成真值，字节长度也变了
  writeFileSync(f, line(1_000_000) + '\n');
  const second = [...gatewayRows({ dir, cutoff: 0, pricing, machine: 'm', cursors })];
  assert.equal(second.length, 1, '游标失效 → 整文件重扫，那一行必须再出来一次');
  assert.equal(second[0].i, 1_000_000, '读到的是改写后的值（库里靠 MAX 补上）');

  // 内容没变时不该白扫：游标有效就不重复产出
  const third = [...gatewayRows({ dir, cutoff: 0, pricing, machine: 'm', cursors })];
  assert.equal(third.length, 0, '没新内容就不该重复产出（游标仍在起作用）');

  // 时间兜底：超过 10 分钟没整文件重扫过，就重扫一次（对付「长度没变但内容变了」的改写）
  cursors[f].scannedAt = Date.now() - 11 * 60 * 1000;
  const fourth = [...gatewayRows({ dir, cutoff: 0, pricing, machine: 'm', cursors })];
  assert.equal(fourth.length, 1, '时间兜底到点 → 重扫一次');
});

test('reprice 按当前价目重算，且不动已被修剪的汇总行', async () => {
  // 「流水进 SQLite」最直接的回报：价目表补一个模型之后，历史不用重建——重算一遍就对了。
  // 旧账本时代美元在解析那一刻就写死了，补价目只能影响以后。
  const store = new UsageStore({ file: join(tmp, 'reprice.db'), machine: 'm1' });
  const HOUR = Math.floor(T0 / 3600);
  store.insertCalls([
    // 一行价写错的（模拟「当时没价、后来补了」）
    { key: 'g|a', src: 'g', ts: T0, model: 'claude-opus-5', i: 1_000_000, o: 0, cr: 0, cw: 0, usd: 0, priced: 0, billable: 1, machine: 'm1' },
    // 一行价目表里永远没有的（原来那 99 是错的）
    { key: 'g|b', src: 'g', ts: T0 + 1, model: 'totally-bogus-model', i: 1_000_000, o: 0, cr: 0, cw: 0, usd: 99, priced: 1, billable: 1, machine: 'm1' },
  ]);
  // 一条「明细已被修剪」的汇总行：它的小时在 calls 里找不到，重算不该碰它
  store.db.prepare(`INSERT INTO hourly (hour,day,machine,model,sess,ws,src,side,priced,billable,usd,i,o,cr,cw,n)
    VALUES (?,?,0,0,0,0,'g','g',1,1,7,0,0,0,0,1)`).run(HOUR - 1000, 20260101);

  const fake = { price: (m) => (m === 'claude-opus-5' ? [5, 25, 0.5, 6.25] : null) };
  const r = store.reprice({ pricing: fake });
  assert.equal(r.unpriced.includes('totally-bogus-model'), true, '没价的模型要点名');

  const opus = store.db.prepare("SELECT usd, priced FROM calls c JOIN dims d ON d.id=c.model WHERE d.name='claude-opus-5'").get();
  assert.equal(opus.priced, 1, '补了价 → priced 翻回 1');
  assert.ok(Math.abs(opus.usd - 5) < 1e-9, `1M input × $5/M = $5，实际 ${opus.usd}`);

  const bogus = store.db.prepare("SELECT usd, priced FROM calls c JOIN dims d ON d.id=c.model WHERE d.name='totally-bogus-model'").get();
  assert.equal(bogus.priced, 0, '没价 → 标 priced=0');
  assert.equal(bogus.usd, 0, '没价就不猜：原来那 99 是错的，清成 0');
  assert.equal(r.hourlyStale, 1, '被修剪过的那条汇总行如实报出来（没动它）');
  assert.equal(store.db.prepare('SELECT usd FROM hourly WHERE hour = ?').get(HOUR - 1000).usd, 7, '它保持原样');

  // 幂等：再跑一次不改任何行（价没变，重算就该是空操作）
  assert.equal(store.reprice({ pricing: fake }).calls, 0, '价格没变时重算是空操作');
  store.close();
});
