/**
 * 发版：打包 → 用 gh 把安装包、blockmap、latest.yml 传到 GitHub Releases。
 *
 * 各机器上的 electron-updater 只读 latest.yml 判断有没有新版，再拿 blockmap 与本机
 * 已装的那份逐块比对，只用 HTTP Range 下改动的块——所以三件必须齐发，缺 blockmap
 * 就退化成每次全量 87MB（差分正是选安装版而非 portable 的唯一理由，见 README）。
 *
 * 幂等：同一版本重跑走 upload --clobber 覆盖同名资产，不会多出 release。
 * 认证复用 gh 的登录态，不需要另配 GH_TOKEN。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from '../app/version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/**
 * 一律不走 shell。带空格的参数（--title "MiraQuota 0.6.34"）经 shell 会被拆成两段，
 * 多出来的 "0.6.34" 被 gh 当成要上传的文件，报 `no matches found for 0.6.34`（实测踩过）；
 * node 里 shell:true 还会带 DEP0190 弃用告警。git/gh/node 在 PATH 里，直接 spawn 就够。
 */
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
const runLoud = (cmd, args) => run(cmd, args, { stdio: 'inherit' });
const gh = (args) => runLoud('gh', args);
const die = (msg) => { console.error(`[release] ${msg}`); process.exit(1); };

/**
 * 锚点自愈：版本口径是「base.自 v<base>.0 以来的提交数」（见 app/version.mjs），锚点 tag
 * 缺失时 resolveVersion 会回退 package.json、版本号偏小，发出去会盖旧版。发版路径在算
 * 版本前先补锚：用 pickaxe 找到把 package.json 写成 <base>.0 的那次 bump 提交，打上
 * v<base>.0 并推远端（幂等：tag 已在则只补推）。dao-commit bump 时忘打 tag 也不会漏。
 */
function ensureAnchorTag(base) {
  const anchor = `v${base}.0`;
  if (run('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${anchor}`]).status !== 0) {
    const bumpCommit = run('git', ['log', '--format=%H', '-1',
      '-S', `"version": "${base}.0"`, '--', 'package.json']).stdout?.trim();
    if (!bumpCommit) die(`找不到把 package.json 写成 ${base}.0 的提交，无法定锚点 ${anchor}`);
    if (runLoud('git', ['tag', anchor, bumpCommit]).status !== 0) die(`打锚点 ${anchor} 失败`);
    console.log(`[release] 已补锚点 ${anchor} → ${bumpCommit.slice(0, 8)}`);
  }
  // 推 tag 幂等；推不上去只警告——锚点本地已在，版本算得对，远端 tag 晚点补也不影响本次发版
  if (run('git', ['push', 'origin', `refs/tags/${anchor}`]).status !== 0) {
    console.warn(`[release] 锚点 ${anchor} 推远端失败（不影响本次发版，下次会重试）`);
  }
}

const args = process.argv.slice(2);
const versionAt = args.indexOf('--version');
if (versionAt < 0) {
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  ensureAnchorTag(String(pkgVersion).split('.').slice(0, 2).join('.'));
}
const version = versionAt >= 0 ? args[versionAt + 1] : resolveVersion(ROOT);
if (!/^\d+\.\d+\.\d+$/.test(version)) die('版本号需要 x.y.z 格式');
const tag = `v${version}`;

// 已跟踪文件脏 ⇒ 发出去的包和 tag 指的提交对不上，用户拿到的版本号会撒谎。
// 未跟踪文件不拦（草稿、截图常年躺在仓里），但落在打包目录里的会被打进包，值得提一句。
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']).stdout?.trim();
if (dirty && !args.includes('--allow-dirty')) {
  die(`已跟踪文件还有未提交改动，先提交再发版（确要带着改动发：--allow-dirty）：\n${dirty}`);
}
const strays = (run('git', ['ls-files', '--others', '--exclude-standard', 'app', 'provider', 'widget']).stdout ?? '').trim();
if (strays) console.warn(`[release] 注意：这些文件没提交，但会被打进包里：\n${strays}`);

/**
 * HEAD 必须已经在远端：否则 gh 会把 tag 打在远端分支当前的提交上，而安装包是本地 HEAD
 * 编译的——tag 指着旧代码，release 里躺着新包，事后只能手工 retag（v0.9.2 实测踩过）。
 * 推送失败最常见的原因是网络抖动，那时更要拦住：发出去的东西必须能被追溯到确切提交。
 */
const head = run('git', ['rev-parse', 'HEAD']).stdout?.trim();
const onRemote = run('git', ['branch', '--remotes', '--contains', head]).stdout?.trim();
if (!onRemote) die(`HEAD (${head?.slice(0, 8)}) 还没推到远端，tag 会打在旧提交上。先 git push 再发版。`);

console.log(`[release] ${tag}`);
const built = runLoud('node', ['scripts/dist.mjs', ...args]);
if (built.status !== 0) die('打包失败，未发版');

const assets = [
  join(DIST, `MiraQuota-Setup-${version}.exe`),
  join(DIST, `MiraQuota-Setup-${version}.exe.blockmap`),
  join(DIST, 'latest.yml'),
];
const missing = assets.filter((f) => !existsSync(f));
if (missing.length) die(`产物缺失，发出去也没法自动更新：\n${missing.join('\n')}`);

const exists = run('gh', ['release', 'view', tag]).status === 0;
const r = exists
  ? gh(['release', 'upload', tag, ...assets, '--clobber'])
  // --target 钉死在本次打包的提交上，不让 gh 拿远端分支的当前 HEAD 兜底
  : gh(['release', 'create', tag, ...assets, '--target', head,
      '--title', `MiraQuota ${version}`, '--generate-notes']);
if (r.status !== 0) die('gh 发布失败');

console.log(`[release] 已发布 ${tag}；各机器在启动 / 打开面板 / 点「检查更新」时即可收到（另有 6 小时兜底轮询）`);
