#!/usr/bin/env node
/**
 * 一条命令部署账本收件口（inbox/）。前提只有一个：`npx wrangler login` 已经点过同意。
 *
 *   node scripts/inbox-deploy.mjs --invite <邀请码>
 *
 * 做的事：建 KV（已有则复用）→ 回填 wrangler.toml → 存邀请码 → deploy → 把 workers.dev 地址
 * 写进 provider/lib/ledger-sync.mjs 的 DEFAULT_INBOX。幂等，重跑无害。
 * 不用 shell 拼命令（release.mjs 踩过 shell 拆参数的坑），一律 spawn 数组参数。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inboxDir = join(root, 'inbox');
const tomlPath = join(inboxDir, 'wrangler.toml');
const syncPath = join(root, 'provider', 'lib', 'ledger-sync.mjs');

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const invite = arg('--invite');

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
function wrangler(args, { input } = {}) {
  const r = spawnSync(npx, ['--yes', 'wrangler', ...args], {
    cwd: inboxDir, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',   // npx.cmd 在 Windows 上要经 cmd 启动；参数里没有用户输入以外的空格
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) { console.error(out); throw new Error(`wrangler ${args.join(' ')} 失败`); }
  return out;
}

const who = wrangler(['whoami']);
if (/not authenticated/i.test(who)) {
  console.error('[inbox] 还没登录 Cloudflare：先跑 `npx wrangler login`（浏览器点一次同意）再来。');
  process.exit(2);
}

// 1) KV：已有同名就复用
let toml = readFileSync(tomlPath, 'utf8');
let kvId = toml.match(/^id = "([0-9a-f]{32})"/m)?.[1] ?? null;
if (!kvId) {
  const list = wrangler(['kv', 'namespace', 'list']);
  const existing = (() => { try { return JSON.parse(list.slice(list.indexOf('['))); } catch { return []; } })()
    .find((n) => n.title === 'miraquota-inbox-ACCOUNTS');
  if (existing) kvId = existing.id;
  else {
    const created = wrangler(['kv', 'namespace', 'create', 'ACCOUNTS']);
    kvId = created.match(/id\s*=\s*"([0-9a-f]{32})"/)?.[1] ?? created.match(/([0-9a-f]{32})/)?.[1];
    if (!kvId) throw new Error('没从 wrangler 输出里读到 KV id：\n' + created);
  }
  toml = toml.replace(/^id = ".*"$/m, `id = "${kvId}"`);
  writeFileSync(tomlPath, toml);
  console.log(`[inbox] KV ACCOUNTS = ${kvId}`);
}

// 2) 邀请码（唯一的秘密）
if (invite) {
  wrangler(['secret', 'put', 'INVITE_CODE'], { input: invite + '\n' });
  console.log('[inbox] 邀请码已存');
} else {
  console.log('[inbox] 未传 --invite，沿用已有的邀请码（首次部署必须传）');
}

// 3) 部署，抓地址
const dep = wrangler(['deploy']);
const url = dep.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
if (!url) { console.log(dep); throw new Error('没从 deploy 输出里读到 workers.dev 地址'); }
console.log(`[inbox] 已部署 ${url}`);

// 4) 写回默认收件口
let src = readFileSync(syncPath, 'utf8');
const before = src.match(/export const DEFAULT_INBOX = '([^']+)';/)?.[1];
if (before !== url) {
  src = src.replace(/export const DEFAULT_INBOX = '[^']+';/, `export const DEFAULT_INBOX = '${url}';`);
  writeFileSync(syncPath, src);
  console.log(`[inbox] DEFAULT_INBOX ${before} → ${url}（记得提交并发版）`);
}
// 轻客户端里烤着地址（朋友拿到的是文件，不一定从 Worker 下）：地址变了三份一起改
for (const f of ['inbox/lite.bat', 'inbox/lite.ps1', 'MiraQuota-Lite.bat']) {
  const p = join(root, f);
  const s = readFileSync(p, 'utf8');
  const n = s.replace(/https:\/\/[a-z0-9.-]+\.workers\.dev\b|https:\/\/inbox\.[a-z0-9.-]+/g, url);
  if (n !== s) { writeFileSync(p, n); console.log(`[inbox] 已更新 ${f} 里的地址`); }
}
console.log(`[inbox] 体检：${url}/health · 轻客户端：${url}/lite.bat · 仓库根目录 MiraQuota-Lite.bat 可直接发给朋友`);
