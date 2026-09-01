/**
 * 版本口径的行为测试（2026-09-02 用户拍板）：补丁位 = 自锚点 tag v<base>.0 以来的提交数，
 * minor bump 归零——SemVer 的 patch 归零 MUST，此前「仓库总提交数」不归零是违反的。
 * 用临时 git 仓实测 resolveVersion，不依赖本仓的 tag 状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveVersion } from '../app/version.mjs';

function repoWith(version) {
  const dir = mkdtempSync(join(tmpdir(), 'mq-ver-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true });
  git('init', '--quiet');
  git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  git('config', 'commit.gpgsign', 'false');
  const commit = (msg) => { writeFileSync(join(dir, 'f.txt'), msg); git('add', '-A'); git('commit', '--quiet', '-m', msg); };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  commit('bump');
  return { dir, git, commit };
}

test('patch counts commits since the anchor tag and resets on a minor bump', () => {
  const { dir, git, commit } = repoWith('0.8.0');
  git('tag', 'v0.8.0');
  assert.equal(resolveVersion(dir), '0.8.0');          // 锚点提交本身就是 .0
  commit('a'); commit('b'); commit('c');
  assert.equal(resolveVersion(dir), '0.8.3');
  // minor bump：换 base、打新锚，补丁位归零重数
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.9.0' }));
  commit('bump 0.9'); git('tag', 'v0.9.0');
  assert.equal(resolveVersion(dir), '0.9.0');
  commit('d');
  assert.equal(resolveVersion(dir), '0.9.1');
});

test('a missing anchor tag falls back to package.json instead of a wrong count', () => {
  const { dir, commit } = repoWith('0.8.0');
  commit('a');
  assert.equal(resolveVersion(dir), '0.8.0');   // 宁可偏小回退，也不数出一个错的补丁位
});

test('the release path self-heals a missing anchor before resolving the version', () => {
  // release.mjs 在算版本前补锚（pickaxe 找 bump 提交打 tag），否则回退版本号会盖旧版
  const src = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8');
  assert.match(src, /ensureAnchorTag/);
  assert.match(src, /'-S', `"version": "\$\{base\}\.0"`/);
  assert.ok(src.indexOf('ensureAnchorTag(') < src.indexOf('resolveVersion(ROOT)'),
    '补锚必须发生在 resolveVersion 之前');
});
