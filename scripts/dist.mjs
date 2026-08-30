/**
 * 打包封装：版本号从 git 自动生成后调 electron-builder，不手改 package.json。
 * 规则：<major.minor 取自 package.json> . <git 提交数>——每次 commit 后打包，
 * 补丁位自动 +1，包名/安装器/关于页全部跟着走。可用 --version x.y.z 覆盖。
 * 透传其余 CLI 参数（如 --publish never）。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from '../app/version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const r = spawnSync('pnpm', ['exec', 'electron-builder', '--win',
  `-c.extraMetadata.version=${version}`, ...passthrough],
  { cwd: ROOT, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
