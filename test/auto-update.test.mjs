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

test('the whole update prompt is one badge in the title bar', () => {
  // 2026-09-02 用户拍板：提示条太占地方，顶部一枚角标就够。点它由主进程弹确认框——
  // 角标紧挨关闭按钮，误点直接重启应用太粗暴。
  assert.match(renderer, /id="newVer"/);
  assert.ok(renderer.includes("badge.style.display = ready ? '' : 'none'"), '角标只在已下载时出现');
  assert.ok(renderer.includes("$('newVer').onclick = () => window.miraquota.promptUpdate"));
  assert.doesNotMatch(renderer, /id="upd"/, '提示条应已删除');
  assert.match(updater, /promptInstall/);
  assert.ok(updater.includes("buttons: ['安装并重启', '稍后']"), '确认框要给出两个选择');
  assert.match(main, /update:prompt/);
  // 标题栏是拖拽区：角标缺 no-drag 就点不动，且界面上完全看不出异常（v0.9.6 实测踩过，
  // 删提示条时把角标样式一起删了，用户点了半天没反应）。
  const badgeCss = renderer.slice(renderer.indexOf('.titlebar .newver'), renderer.indexOf('.titlebar .newver') + 260);
  assert.match(badgeCss, /-webkit-app-region: no-drag/);
});

test('checks happen when the user is actually there, not by polling harder', () => {
  // 用户 2026-09-02 拍板：轮询频率不必高（6 小时兜底就行），关键是三个「用户在场」的时机——
  // 启动、打开面板、点面板里的按钮。此前把轮询调到 30 分钟是在补设计缺陷，已回退。
  assert.ok(updater.includes('const EVERY_MS = 6 * 60 * 60 * 1000;'), '兜底轮询 6 小时');
  assert.match(updater, /checkOnShow/);
  assert.ok(main.includes("win.on('show', () => updater?.checkOnShow())"), '面板露面时补查一次');
  assert.match(renderer, /id="btnCheck"/);                       // 面板里看得见的按钮
  assert.match(renderer, /window\.miraquota\.checkUpdate/);
  assert.match(main, /检查更新/);                                 // 托盘那个入口保留
});

test('checking failures never reach the panel', () => {
  // 与多机同步同一套取舍：抖动不报红。检查失败用户也无事可做，只在主动点托盘
  // 「检查更新」时回话。
  assert.ok(renderer.includes("const ready = st?.phase === 'ready';"), '界面只认「已下载」这一个状态');
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
