/**
 * 面板从服务器拿 payload：哪些字段听服务器的、哪些只有本机答得了，以及服务器一断就
 * 原样退回本机那份（降级路径必须与没配 hub 时逐字一致）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { merge, readHubConfig, HubClient, LOCAL_FIELDS, HUB_STALE_AFTER } from '../provider/lib/hub-client.mjs';
import { Hub } from '../server/hub.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-hubc-'));
const NOW = 1_000_000;

const hubPayload = {
  state: 'exact', stateLabel: '精确',
  windows: [{ label: '7d', usedPercent: 81.7, fullUSD: 6137.56 }],
  today: { points: 6593 },
  speed: null,                       // 服务器上没有任何一台机器的实时速度
  roster: null,
  buckets: 0,
  hub: { machines: [{ id: 'a' }, { id: 'b' }] },
};
const local = {
  state: 'reckoned', stateLabel: '推算',
  windows: [{ label: '7d', usedPercent: 40, fullUSD: 2837 }],
  today: { points: 0 },
  speed: { rows: [{ model: 'Opus 5', rate: 45 }] },
  roster: { models: ['claude-opus-5'], unpriced: [] },
  sync: { state: 'ok', mode: 'hub' },
  buckets: 3614,
  pricing: 'builtin',
};

test('account-level numbers come from the server, machine-level ones stay local', () => {
  const m = merge(hubPayload, local, NOW, NOW + 5);
  // 账号级：服务器手里有全部机器的账本，本机算不全
  assert.equal(m.state, 'exact');
  assert.equal(m.windows[0].fullUSD, 6137.56);
  assert.equal(m.today.points, 6593);
  // 机器级：服务器上压根没有这些东西，取服务器的就是把别人的当成自己的
  assert.deepEqual(m.speed, local.speed);
  assert.deepEqual(m.roster, local.roster);
  assert.deepEqual(m.sync, local.sync);
  assert.equal(m.buckets, 3614);
  assert.equal(m.pricing, 'builtin');
  assert.equal(m.fromHub.machines, 2);
  assert.ok(m.fromHub.ageSeconds >= 5);
});

test('the local-field list is the whole contract, and nothing leaks the other way', () => {
  // 本机没有某个机器级字段时，服务器那份里的同名字段也不能顶上——它不是这台机器的
  const m = merge(hubPayload, { ...local, speed: null }, NOW, NOW + 1);
  assert.equal('speed' in m, false, '本机没速度就没有速度卡，不拿服务器的凑数');
  for (const k of LOCAL_FIELDS) assert.ok(k in local || k === 'speed', `LOCAL_FIELDS 里的 ${k} 该有例子`);
});

test('a silent server falls back to the local payload, byte for byte', () => {
  assert.equal(merge(null, local, null, NOW), local, '没数据 ⇒ 原样返回本机那份');
  assert.equal(merge(hubPayload, local, NOW, NOW + HUB_STALE_AFTER + 1), local, '过期 ⇒ 同上');
  const fresh = merge(hubPayload, local, NOW, NOW + HUB_STALE_AFTER - 1);
  assert.equal(fresh.state, 'exact', '还没过期就照用');
});

test('hub config is read from sync.json, and absent means off', () => {
  const f = join(tmp, 'sync.json');
  writeFileSync(f, JSON.stringify({ hub: 'https://x.example/mq/', token: 't' }));
  assert.deepEqual(readHubConfig(f), { hub: 'https://x.example/mq', token: 't' });
  writeFileSync(f, JSON.stringify({ remote: 'git@github.com:a/b.git' }));
  assert.equal(readHubConfig(f), null, 'git 通道的配置不算 hub');
  assert.equal(readHubConfig(join(tmp, 'nope.json')), null);
});

test('the client streams live updates and reconnects on its own', async () => {
  const hub = new Hub({ dataDir: join(tmp, 'live'), token: 'sekrit' });
  const srv = await hub.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cfg = join(tmp, 'live-sync.json');
  writeFileSync(cfg, JSON.stringify({ hub: base, token: 'sekrit' }));

  let pushes = 0;
  const client = new HubClient({ configFile: cfg, onPayload: () => { pushes++; } });
  assert.equal(client.enabled, true);
  client.start();
  // 连上就先推一份当前状态
  for (let i = 0; i < 100 && pushes < 1; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(pushes >= 1, 'SSE 连上应立刻收到一帧');
  assert.equal(client.state, 'ok');

  // 服务器收到新数据 ⇒ 主动推，不用面板去问
  const before = pushes;
  await fetch(`${base}/limits`, {
    method: 'PUT', headers: { authorization: 'Bearer sekrit', 'content-type': 'application/json' },
    body: JSON.stringify({ capturedAt: Date.now() / 1000, machineId: 'm', windows: [{ label: '7d', used: 1, budget: 100, resetAt: Date.now() / 1000 + 600 }] }),
  });
  for (let i = 0; i < 100 && pushes <= before; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(pushes > before, '有新数据就该收到推送');
  assert.equal(client.merge(local).state, 'exact', '合并后以服务器那份为准');

  client.stop();
  await hub.close();
});

test('a wrong token leaves the panel on local data instead of blanking it', async () => {
  const hub = new Hub({ dataDir: join(tmp, 'auth'), token: 'w', readToken: 'r' });
  const srv = await hub.listen(0);
  const cfg = join(tmp, 'auth-sync.json');
  writeFileSync(cfg, JSON.stringify({ hub: `http://127.0.0.1:${srv.address().port}`, token: 'nope' }));
  const client = new HubClient({ configFile: cfg });
  client.start();
  for (let i = 0; i < 60 && client.state !== 'error'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.state, 'error');
  assert.equal(client.merge(local), local, '连不上不该白屏，照旧用本机那份');
  client.stop();
  await hub.close();
});
