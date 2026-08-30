/**
 * 统一版本口径：package.json 前两段 + git 提交数。
 * 例：package.json 0.2.1、仓库 20 次提交 → 0.2.20
 * 打包（dist.mjs）与面板「关于」共用，避免开发态只显示 package.json 第三位。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function resolveVersion(root) {
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const base = String(pkgVersion).split('.').slice(0, 2).join('.');
  try {
    const patch = execSync('git rev-list --count HEAD', { cwd: root }).toString().trim();
    if (/^\d+$/.test(patch)) return `${base}.${patch}`;
  } catch { /* 安装包目录通常没有 .git，走 package.json 全文 */ }
  return pkgVersion;
}
