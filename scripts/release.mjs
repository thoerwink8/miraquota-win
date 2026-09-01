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
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from '../app/version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, shell: true, encoding: 'utf8', ...opts });
const runLoud = (cmd, args) => run(cmd, args, { stdio: 'inherit' });
const die = (msg) => { console.error(`[release] ${msg}`); process.exit(1); };

// 版本口径与 dist 完全一致（package.json 前两段 + 提交数），tag 就是 v<版本>。
const args = process.argv.slice(2);
const versionAt = args.indexOf('--version');
const version = versionAt >= 0 ? args[versionAt + 1] : resolveVersion(ROOT);
if (!/^\d+\.\d+\.\d+$/.test(version)) die('版本号需要 x.y.z 格式');
const tag = `v${version}`;

// 工作区脏 ⇒ 发出去的包和 tag 指的提交对不上，用户拿到的版本号会撒谎。
const dirty = run('git', ['status', '--porcelain']).stdout?.trim();
if (dirty && !args.includes('--allow-dirty')) {
  die(`工作区还有未提交改动，先提交再发版（确要带着改动发：--allow-dirty）：\n${dirty}`);
}

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
const quoted = assets.map((f) => `"${f}"`);
const r = exists
  ? runLoud('gh', ['release', 'upload', tag, ...quoted, '--clobber'])
  : runLoud('gh', ['release', 'create', tag, ...quoted,
      '--title', `MiraQuota ${version}`, '--generate-notes']);
if (r.status !== 0) die('gh 发布失败');

console.log(`[release] 已发布 ${tag}；各机器下次检查更新（启动后 15 秒 / 每 6 小时）即可收到`);
