/**
 * 新机器自动接入多机同步的边界测试。真远端用本地 bare 仓（读得动），
 * 「读不动」用一个不存在的路径——不联网，也不碰 ~/.miraquota。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LedgerSync, DEFAULT_REMOTE } from '../provider/lib/ledger-sync.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mq-autojoin-'));
const git = (...args) => new Promise((resolve, reject) => {
  execFile('git', args, { timeout: 30_000, windowsHide: true },
    (err, stdout, stderr) => err ? reject(new Error(String(stderr || err))) : resolve(String(stdout)));
});

/** 一个真能 ls-remote 的远端：本地 bare 仓。 */
async function readableRemote(name) {
  const dir = join(tmp, `${name}.git`);
  await git('init', '--bare', '--quiet', dir);
  return dir;
}

const syncAt = (name) => new LedgerSync({
  configFile: join(tmp, `${name}-sync.json`),
  repoDir: join(tmp, `${name}-repo`),
  machineId: name,
});

test('a fresh machine that can read the default repo joins by itself', async () => {
  const remote = await readableRemote('reachable');
  const s = syncAt('fresh');
  assert.equal(s.enabled, false);

  assert.equal(await s.tryAutoJoin({ remote }), true);
  assert.equal(s.enabled, true);
  assert.equal(s.autoJoined, true);
  const written = JSON.parse(readFileSync(s.configFile, 'utf8'));
  // 写进去的必须就是探通的那个地址，且带来源标记
  assert.equal(written.remote, remote);
  assert.equal(written.intervalSec, 600);
  assert.match(written.autoJoinedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.status().autoJoined, true);
});

test('a machine that cannot read the repo stays completely off', async () => {
  const s = syncAt('nocreds');
  assert.equal(await s.tryAutoJoin({ remote: join(tmp, 'does-not-exist.git') }), false);
  // 陌生人装了公开版就是这一行：没配置文件、没启用、没错误、payload 里连 sync 字段都没有
  assert.equal(existsSync(s.configFile), false);
  assert.equal(s.enabled, false);
  assert.equal(s.lastError, null);
});

test('an existing config is never overwritten, however it looks', async () => {
  const remote = await readableRemote('reachable2');
  for (const [name, content] of [
    ['manual', JSON.stringify({ remote: 'https://example.invalid/mine.git' })],
    ['optout', JSON.stringify({ autoJoin: false })],
    ['broken', '{ this is not json'],
  ]) {
    const s = syncAt(name);
    writeFileSync(s.configFile, content);
    const before = readFileSync(s.configFile, 'utf8');
    assert.equal(await s.tryAutoJoin({ remote }), false, `${name} 不该被自动接入`);
    assert.equal(readFileSync(s.configFile, 'utf8'), before, `${name} 的配置被改写了`);
  }
  // {"autoJoin": false} 就是关闭开关：文件在 ⇒ 不再探测；没有 remote ⇒ 同步本就关闭
  assert.equal(syncAt('optout').enabled, false);
});

test('the baked default remote is a real https git url', () => {
  assert.match(DEFAULT_REMOTE, /^https:\/\/.+\.git$/);
});

test('background git never opens an interactive credential prompt', () => {
  // 托盘应用弹不出终端，凭据管理器却能弹登录窗——用户会看到「我没干什么，突然要我登录」
  const src = readFileSync(new URL('../provider/lib/ledger-sync.mjs', import.meta.url), 'utf8');
  assert.match(src, /GIT_TERMINAL_PROMPT: '0'/);
  assert.match(src, /GCM_INTERACTIVE: 'never'/);
  assert.match(src, /env: NO_PROMPT_ENV/);
});
