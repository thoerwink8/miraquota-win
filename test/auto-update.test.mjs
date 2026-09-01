/**
 * 自动更新的契约测试。没有真机跑不了的部分（下载、安装）不测，只钉死几处
 * 一旦漂移就会静默失效的约定——尤其命名：latest.yml 里的下载地址由产物名生成，
 * 两边差一个空格，各机器就会 404，而本机打包一切正常，发现时已经发出去了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json'));
const dist = read('../scripts/dist.mjs');
const release = read('../scripts/release.mjs');
const updater = read('../app/updater.mjs');
const main = read('../app/main.mjs');
const renderer = read('../app/renderer/index.html');

test('windows target stays nsis — portable has no differential update', () => {
  // 差分（只下改动的块，日常几 MB）是 2026-09-02 从免安装换成安装版的唯一理由；
  // 谁把 target 改回 portable，等于让所有机器每次重下近百 MB。
  const targets = pkg.build.win.target.map((t) => t.target ?? t);
  assert.deepEqual(targets, ['nsis']);
  assert.equal(pkg.build.publish[0].provider, 'github');
});

test('artifact name has no spaces, matching the URL in latest.yml', () => {
  const name = pkg.build.nsis.artifactName;
  assert.ok(!name.includes(' '), `artifactName 不能含空格：${name}`);
  // 三处必须用同一个名字：打包保留、发版上传、以及 builder 写进 latest.yml 的地址
  const expected = 'MiraQuota-Setup-${version}.exe';
  assert.ok(dist.includes('`' + expected + '`'), 'dist.mjs 保留的产物名与 artifactName 不一致');
  assert.ok(dist.includes('`' + expected + '.blockmap`'), 'dist.mjs 没保留 blockmap');
  assert.ok(release.includes('`' + expected + '`'), 'release.mjs 上传的产物名不一致');
});

test('release ships all three files the updater needs', () => {
  for (const asset of ['.exe`', '.exe.blockmap`', "'latest.yml'"]) {
    assert.ok(release.includes(asset), `发版少传 ${asset}：缺 blockmap 就退化成全量下载`);
  }
  assert.match(release, /--clobber/);           // 同版本重发要幂等
  assert.match(release, /allow-dirty/);         // 脏工作区默认拦住，否则版本号会撒谎
});

test('updates install without the user doing anything', () => {
  assert.match(updater, /autoDownload = true/);
  assert.match(updater, /autoInstallOnAppQuit = true/);
  assert.match(updater, /app\.isPackaged/);     // 开发态没有 app-update.yml，必须空转
  // 托盘常驻：关窗默认只隐藏，装新版前必须先放行真退出，否则永远装不上。
  assert.match(main, /beforeQuit: \(\) => \{ app\.isQuittingForReal = true; \}/);
});

test('update banner shows progress and readiness, never a failed check', () => {
  // 与多机同步同一套呈现取舍：抖动不报红。检查失败用户也无事可做，只在主动点
  // 托盘「检查更新」时回话。
  assert.match(renderer, /s\.phase !== 'downloading' && s\.phase !== 'ready'/);
  assert.match(renderer, /重启更新/);
  assert.match(main, /检查更新/);
  assert.doesNotMatch(renderer, /更新失败/);
});

test('release refuses when HEAD is not on the remote, and pins the tag to that commit', () => {
  // 实测踩过（v0.9.2）：push 因网络失败但发版继续，gh 把 tag 打在远端分支旧提交上，
  // 安装包却是本地 HEAD 编译的——tag 指着旧代码，只能事后手工 retag。
  assert.match(release, /branch', '--remotes', '--contains', head/);
  assert.match(release, /还没推到远端/);
  assert.match(release, /'--target', head/);
});
