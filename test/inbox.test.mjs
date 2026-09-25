/**
 * 收件口通道（2026-09-02 用户拍板）：没有 GitHub 的人靠「名字 + 自设口令 + 一次性邀请码」上传。
 * 这里用一个本地 http 服务冒充 Worker，覆盖：登录/注册顺序、名字唯一、分片校验、
 * 客户端收件口模式的发布与读取、轻客户端原始行分片在账本侧定价落地。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeInbox } from './helpers/inbox-fixture.mjs';
import { validateShard, validateJournal, branchFor, hashPassphrase, verifyPassphrase, ACCOUNT_RE } from '../inbox/shared.mjs';
import { LedgerSync, DEFAULT_INBOX, readInstallId } from '../provider/lib/ledger-sync.mjs';
import { Engine } from '../provider/lib/engine.mjs';
import { CostLedger, STATE_SCHEMA } from '../provider/lib/ledger.mjs';
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

const pricedLedger = (name, data = {}) => {
  const file = join(tmp, `${name}-ledger.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: STATE_SCHEMA, ...data }));
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
  assert.match(engine, /syncLogin: \{ inbox: DEFAULT_INBOX,/);
  const preload = readFileSync(new URL('../app/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /syncLogin: \(opts\) => ipcRenderer\.invoke\('sync:login', opts\)/);
  // hub 通道 2026-09-24 下线：「连自建服务器」那张卡、它的桥和预填地址一个都不许留
  // （留着卡，用户照着填了只会得到一个永远连不上的通道）。
  assert.doesNotMatch(preload, /sync:hub|syncHub/);
  assert.doesNotMatch(renderer, /syncHubCard|btnHub|hubUrl/);
  assert.doesNotMatch(engine, /DEFAULT_HUB/);
});

test('an inbox machine reads its own cache on cold start, and a dead inbox costs it nothing', async () => {
  // 分片存在 Worker 的 KV 里。冷启动（不联网）只读上一轮落下的缓存；收件口读不到只是少几台
  // 机器，不记 error、不改状态色。
  //
  // 从前这条测的是「git 通道的机器顺带读一次收件口，两条通道的人在同一张多机页上」。
  // git 通道 2026-09-23 退役并删掉了，那半句没了前提；缓存与「收件口挂了不抛」这两条照旧。
  const box = await fakeInbox();
  try {
    const MIN = 29_400_000;
    const lite = new LedgerSync({ configFile: join(tmp, 'lite-sync.json'), machineId: 'laptop', installId: 'dddd0000dddd0000', cacheFile: join(tmp, 'lite-cache.json'), retryDelayMs: 1 });
    assert.equal((await lite.login({ inbox: box.url, account: 'fxc', passphrase: 'pass-fxc', invite: 'code' })).ok, true);
    await lite.run(pricedLedger('lite', { buckets: { [MIN]: 3 } }), MIN * 60);
    // 上一轮已把收件口分片落进缓存 → 冷启动（不联网）就能拿到
    writeFileSync(join(tmp, 'owner-cache.json'), JSON.stringify([...box.shards.values()]));
    // 配置文件要在构造**之前**写好：构造时就 #loadConfig 定模式，晚写等于没配
    writeFileSync(join(tmp, 'owner-sync.json'), JSON.stringify({ inbox: box.url, account: 'fxc', passphrase: 'pass-fxc', intervalSec: 600 }));
    const owner = new LedgerSync({ configFile: join(tmp, 'owner-sync.json'), machineId: 'desk', installId: 'eeee0000eeee0000', cacheFile: join(tmp, 'owner-cache.json') });
    assert.equal(owner.mode, 'inbox');
    const got = await owner.loadCachedShards();
    assert.deepEqual(got.map((s) => [s.machineId, s.account]), [['laptop', 'fxc']]);
    // 本机那行也带 account：收件口模式下身份就是「登录的那个名字」（git 通道下它是 null）
    assert.deepEqual(owner.status().machines.map((m) => [m.id, m.account, m.self]), [['desk', 'fxc', true], ['laptop', 'fxc', false]]);
    // 收件口挂了：冷启动只读缓存，不抛；没缓存就是空
    const dead = new LedgerSync({ configFile: join(tmp, 'owner-sync.json'), machineId: 'desk', installId: 'eeee0000eeee0000', cacheFile: join(tmp, 'owner-cache2.json') });
    assert.deepEqual(await dead.loadCachedShards(), []);
  } finally { box.close(); }
});

/**
 * 收件口也收流水明细（用户 2026-09-23：「收件口…我觉得也要流水」）。
 *
 * KV 没有能查询的存储，所以设计与 hub 不同：**推的机器把明细块放上去，读的机器把它写进自己的库**
 * （hub 是服务端落库、大家读服务端）。两条硬边界：只回本账号的（明细里有会话 id 与工作区路径，
 * 不能像聚合分片那样跨账号可读），以及行格式与 hub 是同一套判据。
 */
test('inbox carries journal blocks: pushed by one machine, ingested by the reader', async () => {
  const box = await fakeInbox();
  try {
    const mk = (name, installId) => new LedgerSync({
      configFile: (() => {
        const f = join(tmp, `${name}-jsync.json`);
        writeFileSync(f, JSON.stringify({ inbox: box.url, account: 'fxc', passphrase: 'pass-fxc', intervalSec: 600 }));
        return f;
      })(),
      machineId: name, installId, cacheFile: join(tmp, `${name}-jcache.json`),
    });
    const a = mk('laptop', 'aaaa0000aaaa0000');
    const b = mk('desk', 'bbbb0000bbbb0000');
    await a.login({ inbox: box.url, account: 'fxc', passphrase: 'pass-fxc', invite: 'code' });

    const rows = [{ kh: '111', ts: 1_790_000_000, src: 'g', side: 'g', model: 'claude-opus-5', usd: 1.5, i: 10, o: 0, cr: 0, cw: 0, priced: 1, billable: 1 }];
    assert.equal(await a.pushJournal(rows), 1, '推上去了');

    // 读的一方：run() 把明细带回来（剔掉自己那份）
    const r = await b.run(pricedLedger('desk-j'), 1_790_000_100);
    assert.equal(r.journals.length, 1);
    assert.equal(r.journals[0].installId, 'aaaa0000aaaa0000');
    assert.equal(r.journals[0].rows[0].kh, '111');

    // 自己那份不该回来（本机流水本来就在自己的库里）
    const ra = await a.run(pricedLedger('laptop-j'), 1_790_000_100);
    assert.deepEqual(ra.journals, []);

    // 鉴权：口令不对拿不到明细（与分片那条「只读无鉴权」不同，这里是刻意的）
    const bad = await fetch(`${box.url}/journals`, { headers: { 'x-account': 'fxc', 'x-passphrase': 'wrong' } });
    assert.equal(bad.status, 401);

    // 行形状与 hub 同一套判据
    assert.match(validateJournal({ installId: 'zz', rows }), /installId/);
    assert.match(validateJournal({ installId: 'aaaa0000aaaa0000', rows: [] }), /非空数组/);
    assert.match(validateJournal({ installId: 'aaaa0000aaaa0000', rows: [{ ts: 1 }] }), /第 1 行不完整/);
    assert.equal(validateJournal({ installId: 'aaaa0000aaaa0000', rows }), null);
  } finally { box.close(); }
});

/**
 * 收件口机器**真的会推**流水（不只是 LedgerSync 有那个方法）。
 *
 * 2026-09-23 自查逮到：`pushJournal` 加了收件口分支，但 Engine 的 `#pushJournalDelta` 还写着
 * 「只有 hub 通道收」——于是收件口那条路的推送是死代码：方法在、没人调，测试也全绿。
 * 这条从 Engine 往下跑，推的是真流水行。
 */
test('an inbox-mode engine actually pushes its journal on poll', async () => {
  const box = await fakeInbox();
  try {
    const cfg = join(tmp, 'eng-inbox-sync.json');
    const led = join(tmp, 'eng-inbox-ledger.json');
    writeFileSync(led, JSON.stringify({ schemaVersion: STATE_SCHEMA }));
    const s = new LedgerSync({
      configFile: cfg, machineId: 'laptop', installId: 'cccc0000cccc0000',
      cacheFile: join(tmp, 'eng-inbox-cache.json'),
    });
    assert.equal((await s.login({ inbox: box.url, account: 'fxc', passphrase: 'pass-fxc', invite: 'code' })).ok, true);

    const engine = new Engine({
      forceOffline: true,
      home: join(tmp, 'no-home'),            // 空家目录：refresh 扫不到任何原始记录
      ledgerFile: led,
      anchorFile: join(tmp, 'eng-inbox-anchor.json'),
      settingsFile: join(tmp, 'eng-inbox-set.json'),
      attribFile: join(tmp, 'eng-inbox-attrib.json'),
      calibratorFile: join(tmp, 'eng-inbox-cal.json'),
      fleetOpts: { configFile: join(tmp, 'eng-inbox-no-fleet.json') },
      syncOpts: {
        configFile: cfg, machineId: 'laptop', installId: 'cccc0000cccc0000',
        cacheFile: join(tmp, 'eng-inbox-cache.json'),
      },
    });
    assert.equal(engine.sync.mode, 'inbox');
    const now = Math.floor(Date.now() / 1000);
    engine.ledger.store.insertCalls([{
      key: 'g|eng-journal', src: 'g', ts: now, model: 'claude-opus-5', usd: 2,
      i: 10, o: 0, cr: 0, cw: 0, priced: 1, billable: 1, machine: 'laptop',
    }]);
    engine.ledger.invalidate();
    // 这台原来走 hub、已经把这笔推给 hub 了：老的、不分去处的水位停在「现在」。
    // 换到收件口后不许接着这个进度往下推——收件口一行都还没收到过（审查 2026-09-25 指出会漏 8 天）。
    engine.ledger.store.db.prepare("INSERT INTO meta (k,v) VALUES ('journal_pushed_to',?)").run(String(now + 60));

    await engine.poll();
    const pushed = [...box.journals.values()].find((j) => j.installId === 'cccc0000cccc0000');
    assert.ok(pushed, '收件口模式下 poll() 要把流水推上去（死代码 = 这一条红）');
    assert.equal(pushed.rows.length, 1, '别处（hub）的水位不算收件口的进度');
    assert.equal(pushed.rows[0].usd, 2);
    const dest = engine.sync.destination;
    assert.equal(dest, `inbox|${box.url}|fxc`);
    assert.ok(engine.ledger.journalWatermark(dest) >= now, '推完要退这个去处的水位，否则每轮重推 8 天');
    assert.equal(engine.ledger.journalWatermark(`inbox|${box.url}|someone-else`), null, '换个名字就是另一个去处，从头补');
  } finally { box.close(); }
});

test('the friend-facing BAT is a real file with the real address baked in, and stays in step', () => {  // 用户 2026-09-03：BAT 要放仓库里能直接复制给朋友——朋友拿到的是文件，不一定从 Worker 下，
  // 所以地址必须烤在文件里，不能留占位符；根目录那份与 inbox/lite.bat 只能是同一份（CRLF 归一后）。
  const root = readFileSync(new URL('../MiraQuota-Lite.bat', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../inbox/lite.bat', import.meta.url), 'utf8');
  const ps1 = readFileSync(new URL('../inbox/lite.ps1', import.meta.url), 'utf8');
  for (const s of [root, src, ps1]) { assert.ok(!s.includes('__INBOX_URL__'), '不许留占位符'); assert.ok(s.includes(DEFAULT_INBOX), '烤进默认收件口'); }
  assert.equal(root.replace(/\r?\n/g, '\n'), src.replace(/\r?\n/g, '\n'), '两份 BAT 内容一致');
  assert.ok(root.includes('\r\n'), 'cmd 要 CRLF');
  assert.match(readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8'), /\*\.bat text eol=crlf/);
  const rel = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8');
  assert.ok(rel.includes("'MiraQuota-Lite.bat'"), '随版发到 GitHub Releases');
});
