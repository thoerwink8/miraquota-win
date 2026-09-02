/**
 * 收件口通道（2026-09-02 用户拍板）：没有 GitHub 的人靠「名字 + 自设口令 + 一次性邀请码」上传。
 * 这里用一个本地 http 服务冒充 Worker，覆盖：登录/注册顺序、名字唯一、分片校验、
 * 客户端收件口模式的发布与读取、轻客户端原始行分片在账本侧定价落地。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateShard, branchFor, hashPassphrase, verifyPassphrase, ACCOUNT_RE } from '../inbox/shared.mjs';
import { LedgerSync, DEFAULT_INBOX, readInstallId } from '../provider/lib/ledger-sync.mjs';
import { CostLedger } from '../provider/lib/ledger.mjs';
import { Pricing } from '../provider/lib/pricing.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-inbox-'));

test('passphrases round-trip through PBKDF2 and wrong ones fail', async () => {
  const rec = await hashPassphrase('open-sesame');
  assert.equal(await verifyPassphrase('open-sesame', rec), true);
  assert.equal(await verifyPassphrase('open-sesamE', rec), false);
  assert.equal(await verifyPassphrase('x', null), false);
});

test('shard validation accepts both shapes and names the first thing wrong', () => {
  const base = { schemaVersion: 1, machineId: 'pc', installId: 'abcdef0123456789', account: 'fxc', generatedAt: 1, coverage: { fromSec: 0, toSec: 1 }, buckets: {} };
  assert.equal(validateShard(base, 'fxc'), null);
  assert.equal(validateShard({ ...base, account: 'bob' }, 'fxc'), '分片里的 account 与登录身份不一致');
  assert.equal(validateShard({ ...base, installId: 'ZZ' }, 'fxc'), 'installId 要是 8–32 位十六进制');
  assert.equal(validateShard({ ...base, buckets: { a: 'x' } }, 'fxc'), 'buckets 不是「键→数」');
  const raw = { ...base, schemaVersion: 2, buckets: undefined, rows: [{ t: 1, m: 'kimi-k3', i: 1, o: 2 }] };
  assert.equal(validateShard(raw, 'fxc'), null);
  assert.equal(validateShard({ ...raw, rows: [{ m: 'x' }] }, 'fxc'), 'rows 里有行缺 t/m');
  assert.equal(branchFor('fxc', 'abcdef0123456789'), 'machine/fxc--abcdef012345');
  assert.ok(ACCOUNT_RE.test('fxc') && !ACCOUNT_RE.test('Fxc') && !ACCOUNT_RE.test('-x'));
});

test('install id is generated once and reused', () => {
  const f = join(tmp, 'install.json');
  const a = readInstallId(f);
  assert.match(a, /^[a-f0-9]{16}$/);
  assert.equal(readInstallId(f), a);
  writeFileSync(f, 'garbage');
  assert.notEqual(readInstallId(f), a, '文件坏了就重生成，不承载账目所以无妨');
});

/** 冒充 Worker：内存账号表、内存分片表，语义与 inbox/worker.mjs 一致。 */
function fakeInbox({ invite = 'code' } = {}) {
  const accounts = new Map();
  const shards = new Map();
  const log = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : null;
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj == null ? '' : JSON.stringify(obj)); };
    log.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/register') {
      if (body.invite !== invite) return send(403, { error: '邀请码不对' });
      if (accounts.has(body.account)) return send(409, { error: '这个名字已经有人用了，换一个' });
      accounts.set(body.account, body.passphrase);
      return send(201, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/login') {
      return accounts.get(body.account) === body.passphrase ? send(204) : send(401, { error: '名字或口令不对' });
    }
    if (req.method === 'PUT' && req.url === '/shard') {
      const acct = req.headers['x-account'];
      if (accounts.get(acct) !== req.headers['x-passphrase']) return send(401, { error: '名字或口令不对' });
      const why = validateShard(body, acct);
      if (why) return send(400, { error: why });
      shards.set(branchFor(acct, body.installId), body);
      return send(204);
    }
    if (req.method === 'GET' && req.url === '/shards') return send(200, [...shards.values()]);
    send(404, { error: 'no such endpoint' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, accounts, shards, log, close: () => server.close() });
  }));
}

const pricedLedger = (name, data = {}) => {
  const file = join(tmp, `${name}-ledger.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: 2, ...data }));
  return new CostLedger(new Pricing(join(tmp, 'no-cache.json')), file);
};

test('login tries the passphrase first and only asks for an invite when the name is new', async () => {
  const box = await fakeInbox();
  try {
    const cfg = join(tmp, 'login-sync.json');
    const s = new LedgerSync({ configFile: cfg, repoDir: join(tmp, 'login-repo'), machineId: 'pc', installId: 'aaaabbbbccccdddd', cacheFile: join(tmp, 'login-cache.json') });
    assert.equal(s.enabled, false);
    // 新名字、没邀请码：明确说要邀请码，不写文件
    let r = await s.login({ inbox: box.url, account: 'fxc', passphrase: 'secret1' });
    assert.deepEqual(r, { ok: false, error: '这个名字还没注册，需要邀请码', needInvite: true });
    assert.ok(!existsSync(cfg));
    // 邀请码错
    r = await s.login({ inbox: box.url, account: 'fxc', passphrase: 'secret1', invite: 'nope' });
    assert.equal(r.ok, false); assert.match(r.error, /邀请码不对/);
    // 邀请码对：注册成功，写配置，切到收件口模式
    r = await s.login({ inbox: box.url, account: 'fxc', passphrase: 'secret1', invite: 'code' });
    assert.deepEqual(r, { ok: true, registered: true });
    assert.equal(s.enabled, true); assert.equal(s.mode, 'inbox');
    assert.deepEqual(JSON.parse(readFileSync(cfg, 'utf8')), { inbox: box.url, account: 'fxc', passphrase: 'secret1', intervalSec: 600 });
    // 同名再注册（另一台机器、口令对）：走 /login，不要邀请码，也不重复注册
    const s2 = new LedgerSync({ configFile: join(tmp, 'login2-sync.json'), repoDir: join(tmp, 'login2-repo'), machineId: 'pc2', installId: '1111222233334444', cacheFile: join(tmp, 'login2-cache.json') });
    r = await s2.login({ inbox: box.url, account: 'fxc', passphrase: 'secret1' });
    assert.deepEqual(r, { ok: true, registered: false });
    // 同名、口令不对、带邀请码：服务端只认一个 fxc，拒绝并说清楚
    const s3 = new LedgerSync({ configFile: join(tmp, 'login3-sync.json'), repoDir: join(tmp, 'login3-repo'), machineId: 'pc3', installId: '5555666677778888', cacheFile: join(tmp, 'login3-cache.json') });
    r = await s3.login({ inbox: box.url, account: 'fxc', passphrase: 'other-pass', invite: 'code' });
    assert.equal(r.ok, false); assert.match(r.error, /已经有人用了/);
    assert.equal(box.accounts.size, 1, '服务端只能有一个 fxc');
    // 名字格式与口令长度在客户端就挡下
    assert.match((await s3.login({ inbox: box.url, account: 'Fxc!', passphrase: 'secret1' })).error, /名字只能是/);
    assert.match((await s3.login({ inbox: box.url, account: 'ok', passphrase: '12' })).error, /口令至少/);
  } finally { box.close(); }
});

test('inbox mode publishes over HTTP, reads everyone back, and caches for cold start', async () => {
  const box = await fakeInbox();
  try {
    const MIN = 29_200_000;
    const mk = async (name, installId, buckets) => {
      const s = new LedgerSync({ configFile: join(tmp, `${name}-sync.json`), repoDir: join(tmp, `${name}-repo`), machineId: name, installId, cacheFile: join(tmp, `${name}-cache.json`), retryDelayMs: 1 });
      assert.equal((await s.login({ inbox: box.url, account: name, passphrase: 'pass-' + name, invite: 'code' })).ok, true);
      return { s, led: pricedLedger(name, { buckets }) };
    };
    const a = await mk('alice', 'aaaa0000aaaa0000', { [MIN]: 2 });
    const b = await mk('bob', 'bbbb0000bbbb0000', { [MIN]: 5 });
    const ra = await a.s.run(a.led, MIN * 60 + 30);
    assert.equal(ra.state, 'ok'); assert.equal(ra.mode, 'inbox'); assert.equal(ra.account, 'alice');
    assert.equal(ra.shards.length, 0, 'bob 还没传');
    const rb = await b.s.run(b.led, MIN * 60 + 40);
    assert.equal(rb.shards.length, 1); assert.equal(rb.shards[0].account, 'alice');
    assert.deepEqual(rb.machines.map((m) => [m.id, m.account, m.self]), [['bob', 'bob', true], ['alice', 'alice', false]]);
    // 分片带身份，Worker 才能定分支名与归人
    const stored = box.shards.get(branchFor('alice', 'aaaa0000aaaa0000'));
    assert.equal(stored.account, 'alice'); assert.equal(stored.installId, 'aaaa0000aaaa0000');
    // 冷启动：不联网，直接从缓存拿到上一轮读到的分片
    const b2 = new LedgerSync({ configFile: join(tmp, 'bob-sync.json'), repoDir: join(tmp, 'bob-repo'), machineId: 'bob', installId: 'bbbb0000bbbb0000', cacheFile: join(tmp, 'bob-cache.json') });
    const cached = await b2.loadCachedShards();
    assert.equal(cached.length, 1); assert.equal(cached[0].machineId, 'alice');
    // 口令改坏 ⇒ 发布 401 ⇒ 人话提示指向重新登录
    writeFileSync(join(tmp, 'bob-sync.json'), JSON.stringify({ inbox: box.url, account: 'bob', passphrase: 'wrong-pass' }));
    const b3 = new LedgerSync({ configFile: join(tmp, 'bob-sync.json'), repoDir: join(tmp, 'bob-repo'), machineId: 'bob', installId: 'bbbb0000bbbb0000', cacheFile: join(tmp, 'bob-cache.json'), retryDelayMs: 1 });
    const r3 = await b3.run(b.led, MIN * 60 + 50);
    assert.equal(r3.pushOk, false); assert.match(r3.errorHint, /重新登录/);
  } finally { box.close(); }
});

test('a lite-client raw-row shard is priced on the reading side, same rules as the local ledger', () => {
  const MIN = 29_300_000;
  const led = pricedLedger('raw');
  led.adoptScopedGroups(['fable']);
  led.adoptForeignShards([{
    schemaVersion: 2, machineId: 'laptop', installId: 'cccc0000cccc0000', account: 'fxc',
    generatedAt: MIN * 60, coverage: { fromSec: 0, toSec: MIN * 60 },
    rows: [
      { t: MIN * 60, m: 'claude-fable-5', i: 1_000_000, o: 0, cr: 0, cw: 0 },        // $10
      { t: MIN * 60 + 5, m: 'claude-haiku-4-5', i: 1_000_000, o: 0, src: 'dispatch' }, // $1 → 调度家族
      { t: MIN * 60 + 9, m: 'mystery-model', i: 700, o: 300 },                        // 没价 → 记 token
    ],
  }]);
  const from = (MIN - 1) * 60, to = (MIN + 1) * 60;
  assert.ok(Math.abs(led.spent(from, to, { includeOpenMinute: true }) - 11) < 1e-9, '有价的两行进总账');
  assert.ok(Math.abs(led.spent(from, to, { includeOpenMinute: true, group: 'fable' }) - 10) < 1e-9, 'fable 分桶');
  assert.ok(Math.abs(led.familySpent(from, to, 'dispatch', { includeOpenMinute: true }) - 1) < 1e-9, 'dispatch 归调度');
  assert.deepEqual(led.unpricedUsage(from, to), [{ model: 'mystery-model', tokens: 1000 }]);
  const rows = led.perMachineSpent(from, to, { group: 'fable', self: { machineId: 'me', installId: 'ffff0000ffff0000', account: null } });
  assert.deepEqual(rows.map((r) => [r.machineId, r.account, r.installId, r.usd, r.groupUSD]),
    [['me', null, 'ffff0000ffff0000', 0, 0], ['laptop', 'fxc', 'cccc0000cccc0000', 11, 10]]);
});

test('the default inbox is a real https url and the login card only shows when sync is off', () => {
  assert.match(DEFAULT_INBOX, /^https:\/\//);
  const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
  assert.match(renderer, /id="syncLoginCard"/);
  assert.match(renderer, /id="btnLogin"/);
  assert.ok(renderer.includes("const canLogin = !sy && !!p.syncLogin;"));
  assert.ok(renderer.includes("$('syncLoginCard').style.display = canLogin ? '' : 'none';"));
  assert.match(renderer, /window\.miraquota\.syncLogin\?\./);
  const engine = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');
  assert.ok(engine.includes("...(!this.sync.enabled ? { syncLogin: { inbox: DEFAULT_INBOX } } : {}),"));
  const preload = readFileSync(new URL('../app/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /syncLogin: \(opts\) => ipcRenderer\.invoke\('sync:login', opts\)/);
});

test('a git-channel machine also sees inbox people, and a dead inbox costs it nothing', async () => {
  // 分片存在 Worker 的 KV 里、不在仓里，git fetch 拿不到——git 通道顺带读一次收件口，
  // 两条通道的人才在同一张多机页上。收件口读不到只是少几台机器，不记 error。
  const box = await fakeInbox();
  try {
    const MIN = 29_400_000;
    const lite = new LedgerSync({ configFile: join(tmp, 'lite-sync.json'), repoDir: join(tmp, 'lite-repo'), machineId: 'laptop', installId: 'dddd0000dddd0000', cacheFile: join(tmp, 'lite-cache.json'), retryDelayMs: 1 });
    assert.equal((await lite.login({ inbox: box.url, account: 'fxc', passphrase: 'pass-fxc', invite: 'code' })).ok, true);
    await lite.run(pricedLedger('lite', { buckets: { [MIN]: 3 } }), MIN * 60);
    // git 通道的机器：上一轮已把收件口分片落进缓存 → 冷启动（不起 git 仓、不联网）就能拿到
    writeFileSync(join(tmp, 'owner-sync.json'), JSON.stringify({ remote: join(tmp, 'nowhere.git') }));
    writeFileSync(join(tmp, 'owner-cache.json'), JSON.stringify([...box.shards.values()]));
    const owner = new LedgerSync({ configFile: join(tmp, 'owner-sync.json'), repoDir: join(tmp, 'owner-repo'), machineId: 'desk', installId: 'eeee0000eeee0000', cacheFile: join(tmp, 'owner-cache.json'), inboxUrl: box.url });
    assert.equal(owner.mode, 'git');
    const got = await owner.loadCachedShards();
    assert.deepEqual(got.map((s) => [s.machineId, s.account]), [['laptop', 'fxc']]);
    assert.deepEqual(owner.status().machines.map((m) => [m.id, m.account, m.self]), [['desk', null, true], ['laptop', 'fxc', false]]);
    // 收件口挂了：冷启动只读缓存，不抛；没缓存就是空
    const dead = new LedgerSync({ configFile: join(tmp, 'owner-sync.json'), repoDir: join(tmp, 'owner-repo'), machineId: 'desk', installId: 'eeee0000eeee0000', cacheFile: join(tmp, 'owner-cache2.json'), inboxUrl: 'http://127.0.0.1:9' });
    assert.deepEqual(await dead.loadCachedShards(), []);
  } finally { box.close(); }
});
