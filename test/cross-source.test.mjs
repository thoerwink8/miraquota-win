/**
 * 美元只认一个来源（2026-09-22 实咬）。
 *
 * 原先 transcript 与网关账本取并集、靠「transcript.requestId == 网关.providerCallId」去重。
 * 这个等式已经不成立：mirasim 把 providerCallId 写成 relay 自己的调用 id（与 relayCallId 同值），
 * 而 transcript 有三分之一的行没有 requestId、只能退回 message.id——两侧 id 交集为 0，于是
 * 同一次调用两边各记一次，本机实测 fable 的美元虚高 1.59 倍、sonnet 1.47 倍，而没有东西报警。
 *
 * 现在：Claude Code 的调用只认 transcript；网关那份进影子账，只用来回答「网关看到的比
 * transcript 多吗」（多了就是 transcript 漏了）。dispatch 是例外——它不写会话文件，只有网关有。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pricing } from '../provider/lib/pricing.mjs';
import { CostLedger } from '../provider/lib/ledger.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-xsrc-'));
const MIN = 29_500_000;
const at = (min) => new Date(min * 60 * 1000).toISOString();

const pricing = () => new Pricing(join(tmp, 'no-cache.json'));
const ledgerAt = (name) => new CostLedger(pricing(), join(tmp, `${name}.json`));

const gatewayRow = (over = {}) => JSON.stringify({
  id: 'g1', ts: at(MIN), agent: 'claude', provider: 'anthropic', model: 'claude-fable-5-1',
  status: 200, viaRelay: true, leg: 'relay', upstreamHost: 'relay.mirasim.ai',
  providerCallId: '43b13fec82437ba24180e6a42010c158',   // relay 的调用 id，不是 Anthropic 的请求 id
  input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0,
  ...over,
});

const window = [(MIN - 1) * 60, (MIN + 1) * 60];

test('a Claude Code call booked from the gateway would be a second copy, so it is not booked', () => {
  const led = ledgerAt('claude-row');
  led.ingestGatewayLine(gatewayRow(), 0);
  assert.equal(led.spent(window[0], window[1], { includeOpenMinute: true }), 0,
    'transcript 已经记过这次调用，网关这份再记就是双计');
  assert.equal(led.spent(window[0], window[1], { includeOpenMinute: true, model: 'claude-fable-5-1' }), 0);
  // 但「网关看见过」这件事要留着：它是唯一能说出 transcript 漏账的独立证人
  const gaps = led.crossSourceGaps(window[0], window[1]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].model, 'claude-fable-5-1');
  assert.ok(Math.abs(gaps[0].gatewayUSD - 10) < 1e-9, 'fable $10/M 输入');
  assert.equal(gaps[0].transcriptUSD, 0);
  assert.equal(gaps[0].ratio, Infinity);
});

test('the gap check stays quiet when the transcript already covers the call', () => {
  const led = ledgerAt('covered');
  led.ingestGatewayLine(gatewayRow(), 0);
  // transcript 记了同一次调用（同样 $10）：账本有钱了，报警就该闭嘴
  led.ingestTranscriptLine(JSON.stringify({
    timestamp: at(MIN), requestId: 'req_x', message: {
      model: 'claude-fable-5-1', usage: { input_tokens: 1_000_000, output_tokens: 0 },
    },
  }), 0);
  assert.ok(Math.abs(led.spent(window[0], window[1], { includeOpenMinute: true }) - 10) < 1e-9,
    '一次调用记一次，$10 不是 $20');
  assert.deepEqual(led.crossSourceGaps(window[0], window[1]), []);
});

test('Mirasim own dispatch calls keep coming from the gateway — nothing else sees them', () => {
  const led = ledgerAt('dispatch');
  led.ingestGatewayLine(gatewayRow({ id: 'd1', modelSource: 'dispatch', model: 'claude-haiku-4-5' }), 0);
  assert.ok(Math.abs(led.spent(window[0], window[1], { includeOpenMinute: true }) - 1) < 1e-9, 'haiku $1/M');
  assert.ok(led.familyIds().includes('dispatch'));
});

test('a non-Claude agent (codex) still books from the gateway — it has no transcript here', () => {
  const led = ledgerAt('codex');
  led.ingestGatewayLine(gatewayRow({ id: 'c1', agent: 'codex', provider: 'openai', model: 'claude-opus-5' }), 0);
  assert.ok(led.spent(window[0], window[1], { includeOpenMinute: true }) > 0);
});

test('per-model buckets split fable-5 from fable-5-1 and ignore the context suffix', () => {
  const led = ledgerAt('models');
  const line = (model, tokens) => JSON.stringify({
    timestamp: at(MIN), requestId: `req_${model}_${tokens}`,
    message: { model, usage: { input_tokens: tokens, output_tokens: 0 } },
  });
  led.ingestTranscriptLine(line('claude-fable-5-1', 1_000_000), 0);
  led.ingestTranscriptLine(line('claude-fable-5-1[1m]', 1_000_000), 0);
  led.ingestTranscriptLine(line('claude-fable-5', 1_000_000), 0);
  const spent = (model) => led.spent(window[0], window[1], { includeOpenMinute: true, model });
  assert.ok(Math.abs(spent('claude-fable-5-1') - 20) < 1e-9, '`[1m]` 与裸名共用一个桶');
  assert.ok(Math.abs(spent('claude-fable-5') - 10) < 1e-9, '5 与 5.1 各自一个桶');
  assert.deepEqual(led.cumulativeByModel(), { 'claude-fable-5-1': 20, 'claude-fable-5': 10 });
  // 分片要带着模型桶走，否则他机的用量在倍率测算里成了无主的点数
  assert.deepEqual(Object.keys(led.exportShard('me').models).sort(),
    [`claude-fable-5-1|${MIN}`, `claude-fable-5|${MIN}`]);
});

test('every model in use has an exact price, and a guessed one says so out loud', () => {
  const p = pricing();
  // 官方价目：Fable 5.1 与 Fable 5 同价，但**缓存读差 4 倍**（$0.25 vs $1.00），
  // 而缓存读占 fable 花费一半以上——这一列填错，账本和倍率一起废
  assert.deepEqual(p.price('claude-fable-5-1'), [10, 50, 0.25, 12.5]);
  assert.deepEqual(p.price('claude-fable-5'), [10, 50, 1.0, 12.5]);
  assert.deepEqual(p.price('claude-opus-5-5'), [4, 20, 0.2, 5]);
  assert.deepEqual(p.price('claude-opus-5'), [5, 25, 0.5, 6.25]);
  assert.deepEqual(p.guessedModels(), [], '在用的模型都该有确切价，不许靠前缀兜底');

  // 兜底仍然保命（宁可有个数也别整条记录消失），但必须留痕给界面点名
  const q = pricing();
  assert.deepEqual(q.price('claude-fable-9-9'), [10, 50, 0.25, 12.5], '按前缀落到 fable-5-1');
  assert.deepEqual(q.guessedModels(), [{ model: 'claude-fable-9-9', via: 'claude-fable-5-1' }]);
});

test('the guessed-price alarm can be re-derived from the ledger, so a restart cannot hide it', () => {
  // 兜底猜价是静默成功的：返回一个看着合理的数，账本照常出数，只有下游的美元会偏。
  // 如果只在解析记录的那一刻记一次，重启后报警就没了，而账本里被猜出来的美元还在——
  // 所以界面每次出 payload 都拿账本里出现过的模型 id 重新问一遍价目表。
  const led = ledgerAt('guess-durable');
  led.ingestTranscriptLine(JSON.stringify({
    timestamp: at(MIN), requestId: 'req_guess', message: {
      model: 'claude-fable-9-9', usage: { input_tokens: 1_000_000, output_tokens: 0 },
    },
  }), 0);
  assert.deepEqual(led.modelIds(), ['claude-fable-9-9']);
  // 新的 Pricing 实例 = 重启后的进程：没解析过任何记录，照样能凭账本点出这个名字
  assert.deepEqual(pricing().guessedAmong(led.modelIds()),
    [{ model: 'claude-fable-9-9', via: 'claude-fable-5-1' }]);
  // 在用的模型一个都不该被点名
  assert.deepEqual(pricing().guessedAmong(['claude-fable-5-1', 'claude-opus-5-5']), []);
});

test('a peer still pushing old-format shards is named, because its dollars stay inflated', () => {
  // 本机把双计修好了，但合并口径里还掺着外机分片。旧版分片的每笔 Claude 调用都记了两次，
  // 而分片里只有总额、没有按模型分桶（模型桶是 v3 才有的），拆不开也认不出——只能让那台
  // 升级并重建。不说出来的话，用户看到的是「账号合计」持续偏高而无从解释。
  const led = ledgerAt('stale-shards');
  const shard = (id, over = {}) => ({
    schemaVersion: 1, machineId: id, generatedAt: MIN * 60,
    coverage: { fromSec: (MIN - 1) * 60, toSec: (MIN + 1) * 60 },
    buckets: { [MIN]: 20 }, scoped: {}, models: {}, family: {}, ...over,
  });
  led.adoptForeignShards([shard('linux-1'), shard('new-box', { models: { [`claude-fable-5-1|${MIN}`]: 10 } })]);
  assert.deepEqual(led.staleForeignShards(), ['linux-1'], '只点名旧口径那台');
  led.adoptForeignShards([shard('linux-1', { models: { [`claude-fable-5-1|${MIN}`]: 10 } })]);
  assert.deepEqual(led.staleForeignShards(), [], '升级重建后就该闭嘴');
  // 什么都没花的机器不算旧口径（空桶无从判断，宁可不说）
  led.adoptForeignShards([shard('idle', { buckets: {} })]);
  assert.deepEqual(led.staleForeignShards(), []);
});

test('swapping the shard set rebuilds the merged per-model table, not just the total', () => {
  // 按模型的合并前缀和也带缓存。换分片时漏掉它，spent({model}) 会继续返回上一批的数——
  // 倍率测算与「谁花的」都读这个口径，读到的却是已经不存在的机器。
  const led = ledgerAt('shard-swap');
  const shard = (id, usd) => ({
    schemaVersion: 1, machineId: id, generatedAt: MIN * 60,
    coverage: { fromSec: (MIN - 1) * 60, toSec: (MIN + 1) * 60 },
    buckets: { [MIN]: usd }, scoped: {}, models: { [`claude-fable-5-1|${MIN}`]: usd }, family: {},
  });
  const perModel = () => led.spent(window[0], window[1], { includeOpenMinute: true, model: 'claude-fable-5-1' });
  led.adoptForeignShards([shard('b', 8)]);
  assert.ok(Math.abs(perModel() - 8) < 1e-9);
  led.adoptForeignShards([shard('c', 1)]);
  assert.ok(Math.abs(perModel() - 1) < 1e-9, '换了一批分片，按模型的表必须跟着换');
});

test('the cached price list cannot quietly override the official built-in one', () => {
  const cache = join(tmp, 'drifted-cache.json');
  writeFileSync(cache, JSON.stringify({
    data: { anthropic: { models: { 'claude-fable-5-1': { cost: { input: 3, output: 9 } } } } },
  }));
  assert.deepEqual(new Pricing(cache).price('claude-fable-5-1'), [10, 50, 0.25, 12.5]);
});

test('a pre-v3 state file is thrown away and rebuilt, because the double count cannot be split', () => {
  // 旧聚合里同一笔调用在两个账目键下各记了一次（本机实测 fable 虚高 1.59 倍），拆不开也
  // 认不出哪一半是重复的——只能清空，让 transcript 与网关账本重扫一遍长回来。这条钉住
  // 「升版本时旧账必须重建」，否则用户升级后看到的还是那笔虚高的钱。
  const file = join(tmp, 'migrate.json');
  writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    buckets: { [MIN]: 20 },
    models: { [`claude-fable-5-1|${MIN}`]: 20 },
    seen: { req_x: MIN }, booked: { req_x: 10 },
    cursors: { 'C:/Users/x/.claude/projects/p/s.jsonl': { size: 999, offset: 999 } },
  }));
  const led = new CostLedger(pricing(), file);
  assert.deepEqual(led.cumulativeByModel(), {}, '旧聚合拆不开，只能清空');
  assert.equal(led.spent(window[0], window[1], { includeOpenMinute: true }), 0);
  // 游标一并归零：原始记录会被重扫，这笔钱只长回来一次
  led.ingestTranscriptLine(JSON.stringify({
    timestamp: at(MIN), requestId: 'req_x', message: {
      model: 'claude-fable-5-1', usage: { input_tokens: 1_000_000, output_tokens: 0 },
    },
  }), 0);
  assert.ok(Math.abs(led.spent(window[0], window[1], { includeOpenMinute: true }) - 10) < 1e-9);
  assert.deepEqual(led.cumulativeByModel(), { 'claude-fable-5-1': 10 });
});
