/**
 * 迁移工具（scripts/store-migrate.mjs）的端到端契约。
 *
 * store.test.mjs 测的是库的 API，这一条测**整条迁移路径**：给一个假家目录，跑
 * `--import`（读三种原始记录 + 标定）→ `--report`（对账）→ `--tasks`（任务归属）→
 * `--rollup`（先汇总后删）→ `--pack`/`--inspect`（迁机器）。这条路径就是"旧数据搬家、
 * 换盘换机器、月底迁 VPS"三件事共用的那一条，坏了不会有第二种表现，只会静默少钱。
 *
 * 用假家目录而不是真机数据：真机数据每天都在变，钉不住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CLI = join(ROOT, 'scripts', 'store-migrate.mjs');

/** 10 天前的一个整点：够旧，`--rollup --keep-days 1` 会把它汇进 hourly。 */
const AT = Math.floor(Date.now() / 1000) - 10 * 86400;
const iso = (sec) => new Date(sec * 1000).toISOString();
const HOUR = 3600;

/** 造一个假家目录：三种原始记录 + 标定，覆盖"两边都有 / 只有网关有 / 有任务 / 有断点"。 */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'mq-cli-home-'));
  const tDir = join(home, '.claude', 'projects', 'D--proj');
  mkdirSync(tDir, { recursive: true });
  // transcript：同一小时内两次调用（各 $10，都是 fable）+ 两小时后第三次（在任务区间外）。
  // 一次带 requestId、一次只有 message.id（实测三分之一是这样）。
  writeFileSync(join(tDir, 'sess-a.jsonl'), [
    JSON.stringify({
      timestamp: iso(AT), requestId: 'req_1', sessionId: 'sess-a', cwd: 'D:\\proj',
      message: { model: 'claude-fable-5-1', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    }),
    JSON.stringify({
      timestamp: iso(AT + 60), sessionId: 'sess-a', cwd: 'D:\\proj',
      message: { id: 'msg_2', model: 'claude-fable-5-1', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    }),
    JSON.stringify({
      timestamp: iso(AT + 2 * HOUR), sessionId: 'sess-a', cwd: 'D:\\proj',
      message: { id: 'msg_3', model: 'claude-fable-5-1', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    }),
  ].join('\n') + '\n');

  const gDir = join(home, '.mirasim', 'insights');
  mkdirSync(gDir, { recursive: true });
  // 网关：同一小时同一模型只记了 $10（比 transcript 少一次 ⇒ 取大该听 transcript 的 $20）
  //      + 另一个模型 $5（transcript 里没有 ⇒ 只有网关记得）
  //      + 一笔没走 relay 的（billable=0，留档但不计钱）
  writeFileSync(join(gDir, 'usage-2026-09.ndjson'), [
    JSON.stringify({
      id: 'sess-a:call-1', ts: iso(AT + 30), sessionId: 'sess-a', agent: 'claude', provider: 'anthropic',
      model: 'claude-fable-5-1', status: 200, viaRelay: true, leg: 'relay',
      upstreamHost: 'relay.mirasim.ai', input: 1_000_000, workspace: 'D:\\proj',
    }),
    JSON.stringify({
      id: 'sess-a:call-2', ts: iso(AT + 90), sessionId: 'sess-a', agent: 'codex', provider: 'openai',
      model: 'claude-opus-5', status: 200, viaRelay: true, leg: 'relay',
      upstreamHost: 'relay.mirasim.ai', input: 1_000_000, workspace: 'D:\\proj',
    }),
    JSON.stringify({
      id: 'sess-a:call-3', ts: iso(AT + 90), sessionId: 'sess-a', agent: 'claude', provider: 'anthropic',
      model: 'claude-opus-5', status: 200, viaRelay: false, leg: 'direct',
      upstreamHost: 'api.anthropic.com', input: 9_000_000, workspace: 'D:\\proj',
    }),
  ].join('\n') + '\n');

  const sDir = join(home, '.mirasim', 'sessions', 'claude', 'sess-a');
  mkdirSync(sDir, { recursive: true });
  writeFileSync(join(sDir, 'turns.jsonl'), JSON.stringify({
    taskId: 'task-1', sessionId: 'sess-a', model: 'claude-fable-5-1',
    startedAt: AT * 1000, updatedAt: (AT + 300) * 1000, usage: { inputTokens: 1, outputTokens: 1 },
    prompt: '把这件事做完',
  }) + '\n');

  // 标定：点数两个采样（增量 100），marks 一个正常点 + 一个 gap（基准断）
  const mDir = join(home, '.miraquota');
  mkdirSync(mDir, { recursive: true });
  writeFileSync(join(mDir, 'calibration.json'), JSON.stringify({
    points: {
      '5h': [
        { at: AT, used: 100, budget: 143_528, resetAt: AT + 5 * HOUR },
        { at: AT + 60, used: 200, budget: 143_528, resetAt: AT + 5 * HOUR },
      ],
    },
    marks: [
      { at: AT, d: { 'claude-fable-5-1': 3 } },
      { at: AT + 30, gap: true },
      { at: AT + 60, d: { 'claude-fable-5-1': 2 } },
    ],
  }));
  return home;
}

const run = (args) => execFileSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 60_000, windowsHide: true,
  env: { ...process.env, MIRAQUOTA_STORE: '' },
});

test('the migration CLI walks the whole path: import → report → tasks → rollup → pack', () => {
  const home = fakeHome();
  const store = join(home, 'store.db');
  const base = ['--home', home, '--store', store, '--machine', 'test-box'];

  /* ---- 导入 ---- */
  const imported = run(['--import', ...base]);
  assert.match(imported, /读到 transcript 3 行/);
  assert.match(imported, /网关 3 行/);
  assert.match(imported, /轮次 1 条/);
  assert.match(imported, /标定点数 2 条 · 标定 marks 3 条/);
  assert.match(imported, /口径 max/);

  /* ---- 幂等：再跑一次不该多出行 ---- */
  const again = run(['--import', ...base]);
  assert.match(again, /新插入 0 行/, '同一份原始记录重跑必须幂等');

  /* ---- 对账 ----
     账目：transcript fable $10 + $10（同一小时）+ $10（两小时后）= $30
           网关 fable $10（同一小时）+ opus $5（走 relay）+ opus $9（没走 relay，不计）
     max：那一小时 fable 比大小 → transcript $20 胜（网关那 $10 整条丢掉，不翻倍）
          + 两小时后 transcript $10 + opus $5 = **$35** */
  const report = run(['--report', '--days', '30', ...base]);
  assert.match(report, /生效花费 \$35\.00/);
  assert.match(report, /原始两边：网关 \$15\.00\/2 笔 · transcript \$30\.00\/3 笔/);
  assert.match(report, /claude-opus-5\s+transcript \$0\.00\s+网关 \$5\.00/, '只有网关有的模型要点名');
  assert.match(report, /点数增量 100/);

  /* ---- 任务归属：任务区间只盖住第一小时（$20 + $5），两小时后那笔归不上 ---- */
  const tasks = run(['--tasks', '--days', '30', ...base]);
  assert.match(tasks, /能归到任务的 \$25\.00/);
  assert.match(tasks, /归不上的 \$10\.00/);
  assert.match(tasks, /task-1/);
  assert.match(tasks, /D:\\proj/, '工作区报表要认得出这个项目');

  /* ---- 换口径不动数据 ---- */
  const union = run(['--report', '--days', '30', '--basis', 'union', ...base]);
  assert.match(union, /生效花费 \$45\.00/, '并集 = transcript 30 + 网关 15（旧账本就是这么重复计的）');
  const transcriptOnly = run(['--report', '--days', '30', '--basis', 't', ...base]);
  assert.match(transcriptOnly, /生效花费 \$30\.00/);

  /* ---- 保留：先汇总后删，总额一分不差 ---- */
  const rolled = run(['--rollup', '--keep-days', '1', ...base]);
  assert.match(rolled, /删除 \d+ 行/);
  const after = run(['--report', '--days', '30', ...base]);
  assert.match(after, /生效花费 \$0\.00/, '明细已删，主行没有明细可算');
  assert.match(after, /另有 \$35\.00 来自已汇总的老明细/, '汇总必须把总额原样接住');
  const db = new DatabaseSync(store);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, 0, '老明细已删');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM hourly').get().n > 0, '小时汇总留着');
  // 计费与不计费的两笔 opus 落在同一天同一会话：汇总的主键必须把它们分成两行，
  // 否则一行覆盖另一行 —— 这是"先汇总后删"路径上的静默丢数。
  assert.ok(db.prepare('SELECT COUNT(*) n FROM hourly WHERE billable = 0').get().n > 0, '不计费那笔也留档');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM hourly WHERE billable = 1').get().n > 0);
  // marks 的 gap 被标成 broken，跨它的区间不可比
  assert.equal(db.prepare('SELECT broken FROM marks WHERE at = ? AND model = ?').get(AT + 30, 'claude-fable-5-1').broken, 1);
  db.close();

  /* ---- 迁机器：打包 + 校验 ---- */
  const pack = join(home, 'snapshot.db');
  const packed = run(['--pack', pack, ...base]);
  assert.match(packed, /已打包/);
  const info = run(['--inspect', pack]);
  assert.match(info, /integrity ok/);
  assert.match(info, /schema 3/);
  assert.ok(existsSync(pack));
  // 快照能被当成一个库打开，口径与数字都在
  const reopened = new DatabaseSync(pack);
  assert.equal(reopened.prepare('SELECT v FROM meta WHERE k = ?').get('basis').v, 'max');
  assert.equal(reopened.prepare('SELECT COUNT(*) n FROM hourly').get().n > 0, true);
  reopened.close();
});

test('the CLI refuses to invent numbers when there is nothing to read', () => {
  const home = mkdtempSync(join(tmpdir(), 'mq-cli-empty-'));
  const base = ['--home', home, '--store', join(home, 'store.db'), '--machine', 'empty-box'];
  const imported = run(['--import', ...base]);
  assert.match(imported, /新插入 0 行/);
  const report = run(['--report', '--days', '8', ...base]);
  assert.match(report, /生效花费 \$0\.00/);
  assert.match(report, /缺口：无/, '没有数据就不该报缺口');
  const tasks = run(['--tasks', '--days', '8', ...base]);
  assert.match(tasks, /总花费 \$0\.00/);
});
