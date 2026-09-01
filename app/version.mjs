/**
 * 统一版本口径（2026-09-02 用户拍板改为 tag 锚定，合 SemVer 的 patch 归零 MUST）：
 *   <major.minor 取自 package.json> . <自锚点 tag v<major.minor>.0 以来的提交数>
 * 例：bump 到 0.8.0 的提交上打 tag v0.8.0，其后第 3 个提交 → 0.8.3；下次 minor 又从 0 数起。
 * setuptools-scm / GitVersion 同族做法（tag + 距离），此前的「仓库总提交数」不归零，违反
 * SemVer。锚点 tag 缺失或无 .git（安装包目录）时回退 package.json 全文（builder 已注入）。
 * 打包（dist.mjs）、发版（release.mjs）与面板「关于」共用，只有这一份口径。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function resolveVersion(root) {
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const base = String(pkgVersion).split('.').slice(0, 2).join('.');
  try {
    const patch = execSync(`git rev-list --count v${base}.0..HEAD`,
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (/^\d+$/.test(patch)) return `${base}.${patch}`;
  } catch { /* 锚点 tag 不存在或无 .git：回退 package.json（发版路径由 release.mjs 保证锚点在） */ }
  return pkgVersion;
}
