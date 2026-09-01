/**
 * 打包封装：版本号从 git 自动生成后调 electron-builder，不手改 package.json。
 * 规则见 app/version.mjs（base.自锚点 tag 以来的提交数）——每次 commit 后打包，
 * 补丁位自动 +1、minor bump 时归零，包名/安装器/关于页全部跟着走。可用 --version x.y.z 覆盖。
 * 打包成功后自动清理 dist 里的历史安装包与 blockmap，只保留本次版本。
 * 透传其余 CLI 参数（如 --publish never）。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from '../app/version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * dist 里的历史产物：MiraQuota-Setup-<版本>.exe(.blockmap)，外加带空格的旧命名
 * （MiraQuota <版本>.exe 免安装包、MiraQuota Setup <版本>.exe）——0.5.32 起产物名不含空格，
 * 因为 latest.yml 里的下载地址就是无空格名，两边必须字字相同，否则更新会 404。
 */
const OLD_ARTIFACT = /^MiraQuota[ -](?:Setup[ -])?[0-9.]+\.exe(?:\.blockmap)?$/;

const args = process.argv.slice(2);
const versionAt = args.indexOf('--version');
const explicitVersion = versionAt >= 0 ? args[versionAt + 1] : null;
if (versionAt >= 0 && !/^\d+\.\d+\.\d+$/.test(explicitVersion || '')) {
  console.error('[dist] --version 需要 x.y.z 格式');
  process.exit(2);
}
const version = explicitVersion || resolveVersion(ROOT);
const passthrough = versionAt >= 0
  ? args.filter((_arg, index) => index !== versionAt && index !== versionAt + 1)
  : args;
console.log(`[dist] version ${version}`);

// 发布交给 scripts/release.mjs 用 gh 传（复用 gh 登录态，不另配 GH_TOKEN）；
// 这里默认 --publish never，免得 builder 见到 tag 或 token 就自作主张发版。
const publishArgs = passthrough.includes('--publish') ? [] : ['--publish', 'never'];
const r = spawnSync('pnpm', ['exec', 'electron-builder', '--win',
  `-c.extraMetadata.version=${version}`, ...publishArgs, ...passthrough],
  { cwd: ROOT, stdio: 'inherit', shell: true });

// 打包成功后再动手清历史产物：只保留本次版本的安装包与它的 blockmap，其余全删。
// blockmap 是差分更新的块索引，必须与 exe 一同发布；删了它，各机器只能下全量。
if (r.status === 0) {
  const distDir = join(ROOT, 'dist');
  const keep = new Set([
    `MiraQuota-Setup-${version}.exe`,
    `MiraQuota-Setup-${version}.exe.blockmap`,
  ]);
  let removed = 0;
  for (const name of readdirSync(distDir)) {
    if (keep.has(name)) continue;
    if (!OLD_ARTIFACT.test(name)) continue;
    unlinkSync(join(distDir, name));
    removed += 1;
    console.log(`[dist] 清理旧产物 ${name}`);
  }
  if (removed) console.log(`[dist] 已删除 ${removed} 个历史安装包，仅保留 ${version}`);
}

process.exit(r.status ?? 1);
