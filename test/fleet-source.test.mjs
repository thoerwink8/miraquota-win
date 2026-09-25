/**
 * fleet-dao 额度表（provider/lib/fleet-source.mjs）：接口约定的客户端一侧。
 * 后端上线之前，拿本地假服务器（scripts/fake-fleet.mjs，形状照 fleet-dao 的 quotaTable()）把约定走一遍。
 *
 * 按 fleet-dao 的底线：读不到、没跑成、格式认不出，都必须是**明确的失败**——每条这样的路径
 * 下面都有一条故意造出来的样本，且断言「上一份好数据还在，但状态说清楚它不是这一次的」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FleetSource, fetchQuota, normalizeBaseUrl, parseQuotaReport, QUOTA_SCHEMA, tokenProblem } from '../provider/lib/fleet-source.mjs';
import { startFakeFleet, sampleQuota } from '../scripts/fake-fleet.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-fleet-'));
let seq = 0;
const cfgPath = () => join(tmp, `fleet-${++seq}.json`);

/** 配好一份 fleet.json 并建一个 FleetSource（不走 connect，测读取本身）。 */
function sourceFor(fake, extra = {}) {
  const configFile = cfgPath();
  writeFileSync(configFile, JSON.stringify({ url: fake.url, token: fake.token }));
  return new FleetSource({ configFile, ...extra });
}

const NOW = Math.floor(Date.now() / 1000);
const pool = (body, id) => body.pools.find((p) => p.poolId === id);

test('the sample report parses, and every server time lands on the local clock', () => {
  const body = sampleQuota(NOW);
  // 服务端钟慢 2 分钟：它说的 asOf 比本机收到时刻早 120 秒
  body.asOf = new Date((NOW - 120) * 1000).toISOString();
  const r = parseQuotaReport(body, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.report.skewSec, 120);
  assert.equal(r.report.staleAfterSec, 30 * 60);
  assert.equal(r.report.pools.length, 6);
  const mira = pool(r.report, 'mirasim');
  assert.equal(mira.name, 'Mirasim 中转', '一个渠道一个池：直接用渠道名');
  assert.equal(pool(r.report, 'claude-solo').name, 'Claude 订阅 · claude-solo', '同渠道两个池：渠道名后挂池编号，分得开');
  const w7 = mira.windows.find((w) => w.label === '7d');
  // 回包里的 readAt 是「服务端的 NOW − 180」，校钟差后是本机的 NOW − 60
  assert.equal(w7.readAt, NOW - 180 + 120);
  assert.deepEqual([w7.used, w7.limit, w7.unit, w7.source], [285_511, 512_600, 'points', 'mirasim-relay']);
  assert.equal(w7.staleSince, undefined);
  assert.equal(mira.windows.find((w) => w.label === '7d_fable').scope, 'fable');
  assert.equal(mira.lastReadOkAt, NOW - 180 + 120);
  // 读数过期、最近一次没读成的池：原因原样带过来，旧读数还在
  const car = pool(r.report, 'claude-carpool');
  assert.deepEqual([car.neverRead, car.readOverdue], [false, true]);
  assert.equal(car.lastError.code, 'not_current');
  assert.equal(car.lastError.message, '这台机器当前挂的不是这个组织，没读');
  assert.equal(car.windows.length, 1);
  // 上游这次没报的窗口：带 staleSince，界面据此注明
  const api = pool(r.report, 'cursor').windows.find((w) => w.label === 'api_percent');
  assert.equal(api.staleSince, NOW - 1800 + 120);
  // fleet-dao 的单位里有 tokens：认，不当坏格子
  const jev = pool(r.report, 'jev');
  assert.deepEqual(jev.windows.map((w) => [w.label, w.unit, w.reading]), [['month_usd', 'usd', 'estimated'], ['daily_tokens', 'tokens', 'estimated']]);
  assert.deepEqual(jev.notes, []);
  assert.equal(pool(r.report, 'cursor').expiresAt, NOW + 9 * 86400 + 120);
});

test('top-level contract breaks are refused outright, with the reason', () => {
  const ok = sampleQuota(NOW);
  const bad = (patch) => parseQuotaReport({ ...ok, ...patch }, NOW);
  assert.match(parseQuotaReport(null, NOW).error, /不是 JSON 对象/);
  assert.match(parseQuotaReport([], NOW).error, /不是 JSON 对象/);
  assert.match(bad({ schema: QUOTA_SCHEMA + 1 }).error, /只认第 1 版——升级 MiraQuota/);
  assert.match(bad({ schema: undefined }).error, /缺 schema/);
  assert.match(bad({ asOf: 'yesterday-ish' }).error, /asOf/);
  assert.match(bad({ staleAfterMinutes: 0 }).error, /staleAfterMinutes/);
  assert.match(bad({ pools: {} }).error, /pools 数组/);
  // 「上游明说 0 个池」不是失败：它和「没读成」在形状上就分得开
  const empty = parseQuotaReport({ ...ok, pools: [] }, NOW);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.report.pools, []);
});

test('a broken pool or window is named, never silently dropped', () => {
  const body = sampleQuota(NOW);
  body.pools.push({ channelId: 'x', channelName: '缺编号的池', neverRead: false, windows: [] });
  body.pools.push({ poolId: 'no-flag', channelId: 'y', channelName: '不说读没读成', windows: [] });
  const mira = pool(body, 'mirasim');
  const base = mira.windows[0];
  mira.windows.push({ ...base, label: '5h' });                                                     // 重复 label
  mira.windows.push({ ...base, label: 'weird', unit: 'furlongs' });                                // 单位不认
  mira.windows.push({ ...base, label: 'moody', upstreamStatus: 'grumpy' });                        // 状态字不认
  mira.windows.push({ ...base, label: 'empty', utilization: null, used: null, limit: null });      // 什么都没有
  mira.windows.push({ ...base, label: 'when', readAt: 'soonish' });                                // 时刻认不出
  const r = parseQuotaReport(body, NOW);
  assert.equal(r.ok, true, '一个池坏了不该把整页拖垮');
  assert.equal(r.report.pools.at(-2).problem, '池缺 poolId');
  assert.equal(r.report.pools.at(-2).name, '缺编号的池');
  assert.match(r.report.pools.at(-1).problem, /缺 neverRead/, '从没读成要明说，不能拿空窗口冒充');
  const m = pool(r.report, 'mirasim');
  assert.deepEqual(m.windows.map((w) => w.label), ['5h', '7d', '7d_claude', '7d_fable', 'weird', 'moody'],
    '新单位、新状态字只拿掉那一项，窗口留下');
  const weird = m.windows.find((w) => w.label === 'weird');
  assert.deepEqual([weird.unit, weird.used, weird.limit, weird.utilization], ['unknown', undefined, undefined, base.utilization],
    '单位说不清的数字不给，只留百分比');
  const moody = m.windows.find((w) => w.label === 'moody');
  assert.deepEqual([moody.upstreamStatus, moody.statusRaw], [undefined, 'grumpy'], '认不出的状态字挪进原字，不当成已知状态');
  const notes = m.notes.join('\n');
  assert.match(notes, /5h 出现了两次/);
  assert.match(notes, /weird：单位 furlongs 这个客户端还不认/);
  assert.match(notes, /moody：上游状态 grumpy 认不出/);
  assert.match(notes, /empty：既没有用量也没有上游状态/);
  assert.match(notes, /when：readAt 不是时间/);
});

test('addresses and tokens are checked before anything is sent', () => {
  assert.deepEqual(normalizeBaseUrl(' http://127.0.0.1:4960/api/quota/ '), { ok: true, url: 'http://127.0.0.1:4960' });
  assert.deepEqual(normalizeBaseUrl('https://fleet.example.com/api'), { ok: true, url: 'https://fleet.example.com' });
  assert.deepEqual(normalizeBaseUrl('https://example.com/fleet/'), { ok: true, url: 'https://example.com/fleet' });
  assert.match(normalizeBaseUrl('http://fleet.example.com').error, /https:\/\//, '令牌是 Bearer，明文 http 等于裸奔');
  assert.match(normalizeBaseUrl('https://me:pw@fleet.example.com').error, /用户名或口令/);
  assert.match(normalizeBaseUrl('https://fleet.example.com/?token=1').error, /\?/);
  assert.equal(normalizeBaseUrl('fleet.example.com').ok, false);
  assert.equal(normalizeBaseUrl('ftp://fleet.example.com').ok, false);
  assert.equal(tokenProblem('fdq_0123456789abcdef'), null);
  assert.match(tokenProblem('fdq_0123\n456789abcdef'), /空白或换行/);
  assert.match(tokenProblem('fdq_0123\u0000456789'), /不可见字符/);
  assert.match(tokenProblem(''), /空的/);
});

test('a token that would break the request header never reaches fetch, and never shows up in a message', async () => {
  // 审查 2026-09-25 实测：fleet.json 里的令牌带着转义换行时，fetch 会把整个请求头连令牌写进报错，
  // 报错又原样进了状态与面板。现在读配置时就拦下，原因里不回显令牌。
  const secret = 'fdq_leakme0123456789';
  let fetched = 0;
  const file = cfgPath();
  writeFileSync(file, JSON.stringify({ url: 'https://fleet.example.com', token: `${secret}\nX-Evil: 1` }));
  const src = new FleetSource({ configFile: file, fetchImpl: async () => { fetched++; throw new Error('不该走到这'); } });
  assert.equal(src.enabled, false);
  assert.equal(await src.refresh(), null);
  assert.equal(fetched, 0, '坏令牌一个请求都不发');
  const st = src.status();
  assert.equal(st.state, 'error', '配置坏了要明说，不当成「没配」');
  assert.equal(st.error.code, 'config');
  assert.match(st.error.message, /令牌里有空白或换行/);
  assert.ok(!JSON.stringify(st).includes(secret), '状态里不许有令牌');

  // 兜底：就算哪一层的报错把令牌带出来了（服务端回显、网络层原文），message 也按原文脱敏
  const echo = async (_url, init) => ({ ok: false, status: 500, headers: new Map(), url: _url,
    json: async () => ({ error: { message: `bad header ${init.headers.authorization}` } }) });
  const r = await fetchQuota('https://fleet.example.com', secret, { fetchImpl: echo });
  assert.equal(r.error.code, 'upstream');
  assert.ok(!r.error.message.includes(secret), r.error.message);
  assert.match(r.error.message, /Bearer \*\*\*/);
  const thrower = async (_url, init) => { throw new TypeError(`invalid header value: ${init.headers.authorization}`); };
  const r2 = await fetchQuota('https://fleet.example.com', secret, { fetchImpl: thrower });
  assert.equal(r2.error.code, 'unreachable');
  assert.ok(!r2.error.message.includes(secret), r2.error.message);
});

test('a good read lands in status, with no token anywhere in it', async (t) => {
  const fake = await startFakeFleet({ t });
  const src = sourceFor(fake);
  assert.equal(src.status().state, 'connecting', '配了但还没读过');
  const r = await src.refresh();
  assert.equal(r.ok, true);
  const st = src.status();
  assert.equal(st.state, 'ok');
  assert.equal(st.url, fake.url);
  assert.equal(st.pools.length, 6);
  assert.deepEqual(st.mirasim, { poolId: 'mirasim', name: 'Mirasim 中转' }, '按窗口的读法认出 Mirasim 池');
  assert.equal(fake.requests.at(-1).authorization, `Bearer ${fake.token}`, '令牌走请求头');
  assert.ok(!JSON.stringify(st).includes(fake.token), '状态里不许有令牌');
});

test('every way of not reading is an explicit failure, and the last good report survives it', async (t) => {
  const fake = await startFakeFleet({ t });
  const src = sourceFor(fake, { timeoutMs: 300 });
  await src.refresh();
  const good = src.report;
  const goodAt = src.fetchedAt;
  const cases = [
    [{ status: 500, error: { error: { code: 'db_down', message: '库连不上' } } }, 'upstream', /HTTP 500：库连不上/],
    [{ status: 403, error: { error: { code: 'forbidden', message: '只读令牌不能读这个' } } }, 'forbidden', /没有读额度的权限/],
    [{ status: 404, error: { error: { code: 'not_found', message: '没有' } } }, 'not_found', /后端还没上线/],
    [{ status: null, raw: '<html>502 Bad Gateway</html>' }, 'bad_response', /不是 JSON/],
    [{ raw: null, body: { ...sampleQuota(NOW), schema: 99 } }, 'bad_response', /回包不符合约定：.*升级 MiraQuota/],
    [{ body: sampleQuota, delayMs: 1_000 }, 'timeout', /超时/],
  ];
  for (const [patch, code, re] of cases) {
    fake.set({ status: null, error: null, raw: null, delayMs: 0, body: sampleQuota, ...patch });
    const r = await src.refresh();
    assert.equal(r.ok, false, `${code} 要是失败`);
    assert.equal(r.error.code, code);
    assert.match(r.error.message, re);
    const st = src.status();
    assert.equal(st.state, 'error', `${code}：状态要说读失败了`);
    assert.equal(st.error.code, code);
    assert.equal(src.report, good, `${code}：上一份好数据留着（只进不退）`);
    assert.equal(st.fetchedAt, goodAt, `${code}：并且说清它是什么时候那份`);
  }
  assert.equal(src.status().failStreak, cases.length);
  // 恢复后清掉失败
  fake.set({ delayMs: 0, body: sampleQuota });
  assert.equal((await src.refresh()).ok, true);
  assert.equal(src.status().state, 'ok');
  assert.equal(src.status().error, undefined);
});

test('a wrong token and a dead port are failures too, before any report exists', async (t) => {
  const fake = await startFakeFleet({ t });
  const cfg = cfgPath();
  writeFileSync(cfg, JSON.stringify({ url: fake.url, token: 'not-the-token' }));
  const wrong = new FleetSource({ configFile: cfg });
  const r = await wrong.refresh();
  assert.equal(r.error.code, 'auth');
  assert.equal(wrong.status().state, 'error');
  assert.equal(wrong.status().pools, undefined, '从没读成过就没有池——不是「0 个池」');

  const deadCfg = cfgPath();
  writeFileSync(deadCfg, JSON.stringify({ url: 'http://127.0.0.1:9', token: 'dead-port-token' }));
  const dead = await new FleetSource({ configFile: deadCfg }).refresh();
  assert.equal(dead.error.code, 'unreachable');
  assert.match(dead.error.message, /连不上 fleet-dao/);
});

test('a redirect is not followed, so the token never reaches another host', async (t) => {
  // 另一台「主机」记下它收到的请求头：跟了跳转，令牌就到它手里了
  const seen = [];
  const elsewhere = createServer((req, res) => { seen.push(req.headers.authorization ?? null); res.end('{}'); });
  await new Promise((r) => elsewhere.listen(0, '127.0.0.1', r));
  t.after(() => elsewhere.close());
  const target = `http://127.0.0.1:${elsewhere.address().port}/api/quota`;
  const hop = createServer((req, res) => { res.writeHead(302, { location: target }); res.end(); });
  await new Promise((r) => hop.listen(0, '127.0.0.1', r));
  t.after(() => hop.close());
  const r = await fetchQuota(`http://127.0.0.1:${hop.address().port}`, 'secret-token');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'config');
  assert.match(r.error.message, /会跳转（HTTP 302 → http:\/\/127\.0\.0\.1:\d+）/);
  assert.deepEqual(seen, [], '跳转目标一个请求都没收到');
});

test('connect checks with a real read before writing, and disconnect forgets everything', async (t) => {
  const fake = await startFakeFleet({ t });
  const file = cfgPath();
  const updates = [];
  const src = new FleetSource({ configFile: file, onUpdate: () => updates.push(1) });
  assert.deepEqual(src.status(), { state: 'off' });

  // 地址不对、令牌不对：都不写文件，并说清错在哪一步
  assert.match((await src.connect({ url: 'http://fleet.example.com', token: fake.token })).error, /https:\/\//);
  assert.equal((await src.connect({ url: fake.url, token: '' })).code, 'config');
  assert.match((await src.connect({ url: fake.url, token: 'abcd efgh ijkl' })).error, /空白或换行/);
  const wrong = await src.connect({ url: fake.url, token: 'nope-nope-nope' });
  assert.equal(wrong.code, 'auth');
  assert.equal(existsSync(file), false, '没验过的令牌不落盘');
  assert.equal(src.enabled, false);

  // 对了才写；地址顺手规整，读到的那份当场可用
  const ok = await src.connect({ url: `${fake.url}/api/quota/`, token: ` ${fake.token} ` });
  assert.deepEqual(ok, { ok: true, pools: 6 });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { url: fake.url, token: fake.token });
  assert.equal(src.status().state, 'ok');
  assert.ok(updates.length >= 1, '接上就叫面板重画，不等心跳');
  assert.ok(!JSON.stringify(ok).includes(fake.token), '返回值里也没有令牌');

  assert.deepEqual(src.disconnect(), { ok: true });
  assert.equal(existsSync(file), false);
  assert.deepEqual(src.status(), { state: 'off' });
  assert.equal(await src.refresh(), null, '断开后不再读');
});

test('only the single Mirasim pool stands in for local Mirasim, and only its fresh measured points', async (t) => {
  const fake = await startFakeFleet({ t });
  const src = sourceFor(fake);
  await src.refresh();
  const snap = src.mirasimSnapshot();
  assert.equal(snap.poolId, 'mirasim');
  assert.equal(snap.staleAfterSec, 1800);
  assert.deepEqual(snap.limits.windows.map((w) => [w.label, w.budget, !!w.modelScoped]),
    [['5h', 143_528, false], ['7d', 512_600, false], ['7d_claude', 512_600, true], ['7d_fable', 271_678, true]]);

  // 上游这次没报（staleSince）的窗口不当现值；有一格旧，龄期就按最旧的那格算
  const body = sampleQuota(NOW);
  const m = pool(body, 'mirasim');
  const isoAgo = (s) => new Date((NOW - s) * 1000).toISOString();
  m.windows[3] = { ...m.windows[3], readAt: isoAgo(7200), staleSince: isoAgo(3600) };
  m.windows[0] = { ...m.windows[0], readAt: isoAgo(900) };
  fake.set({ body });
  await src.refresh();
  const s2 = src.mirasimSnapshot();
  assert.deepEqual(s2.limits.windows.map((w) => w.label), ['5h', '7d', '7d_claude']);
  assert.ok(Math.abs(s2.at - (NOW - 900)) <= 2, `龄期按最旧那格：${NOW - s2.at}`);

  // 两个 Mirasim 池：认不出哪个是本机这个账号，宁可不用，并说出来
  const two = sampleQuota(NOW);
  two.pools.push({ ...pool(two, 'mirasim'), poolId: 'mirasim-2' });
  fake.set({ body: two });
  await src.refresh();
  assert.equal(src.mirasimSnapshot(), null);
  assert.match(src.status().mirasim.skipped, /2 个 Mirasim 池/);
});
