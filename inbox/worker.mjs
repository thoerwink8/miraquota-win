/**
 * MiraQuota 账本收件口（Cloudflare Worker）。
 *
 * 为什么有它（2026-09-02 用户拍板）：共享额度的人没有 GitHub，也不想每加一个人就去开令牌。
 * 于是钥匙只放一处——这里的 GH_TOKEN 能写账本仓；客户端零仓库凭据，只带
 * 「名字 + 自设口令 + 一次性邀请码」，都只在首次输入。加人、换令牌都不动客户端。
 *
 * 身份模型：机器靠随机 installId；人靠自报名字 + 自设口令（PBKDF2 哈希存 KV）。
 * 名字全局唯一——同一个名字只能注册一次（用户 2026-09-02：服务端不能有重名），
 * 之后只有知道口令的人能以这个名字上传。名字是自报的，Worker 保证不了第一次报的是真的。
 *
 * 写入仓库走 Git Data API 造一个**无父提交**并强制更新分支：与 git 客户端的
 * 「单提交覆盖不留历史」同一语义，仓库体积恒定。
 *
 * 接口：
 *   POST /register {account, passphrase, invite}   → 201 / 403 邀请码错 / 409 名字已占
 *   POST /login    {account, passphrase}           → 204 / 401
 *   PUT  /shard    头 x-account / x-passphrase，体分片 JSON（≤3MB） → 204 / 401 / 400 / 429
 *   GET  /shards                                   → 全部分片数组（60 秒缓存）
 *   GET  /lite.bat  GET /lite.ps1                  → 双击即用的轻客户端及其脚本
 *   GET  /health
 * 环境：GH_TOKEN（秘密，仅账本仓 contents 读写）、INVITE_CODE（秘密）、GH_REPO（变量）、ACCOUNTS（KV）。
 */
import LITE_PS1 from './lite.ps1';
import LITE_BAT from './lite.bat';

import { ACCOUNT_RE, hashPassphrase, verifyPassphrase, validateShard, branchFor } from './shared.mjs';

const MAX_BODY = 3 << 20;
const MIN_UPLOAD_GAP_MS = 45_000;
const CACHE_MS = 60_000;

let shardsCache = { at: 0, body: null };

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function gh(env, method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json',
      'user-agent': 'miraquota-inbox', 'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? {} : r.json();
}

/** 无父提交 + 强制更新分支：远端分支永远只有一个提交。 */
async function publishShard(env, branch, shardText) {
  const blob = await gh(env, 'POST', '/git/blobs', { content: shardText, encoding: 'utf-8' });
  const tree = await gh(env, 'POST', '/git/trees', {
    tree: [{ path: 'shard.json', mode: '100644', type: 'blob', sha: blob.sha }],
  });
  const now = new Date().toISOString();
  const commit = await gh(env, 'POST', '/git/commits', {
    message: `shard ${branch.slice('machine/'.length)} @ ${now}`,
    tree: tree.sha, parents: [],
    author: { name: 'miraquota-inbox', email: 'miraquota@local', date: now },
  });
  const ref = await gh(env, 'GET', `/git/ref/heads/${branch}`);
  if (ref) await gh(env, 'PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
  else await gh(env, 'POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
}

async function listShards(env) {
  if (shardsCache.body && Date.now() - shardsCache.at < CACHE_MS) return shardsCache.body;
  const refs = (await gh(env, 'GET', '/git/matching-refs/heads/machine/')) ?? [];
  const out = [];
  for (const ref of refs) {
    const branch = ref.ref.replace(/^refs\/heads\//, '');
    try {
      const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/contents/shard.json?ref=${encodeURIComponent(branch)}`, {
        headers: {
          authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github.raw+json',
          'user-agent': 'miraquota-inbox', 'x-github-api-version': '2022-11-28',
        },
      });
      if (!r.ok) continue;
      const shard = await r.json();
      if (shard && shard.machineId) out.push(shard);
    } catch { /* 单个分片坏不影响其余 */ }
  }
  shardsCache = { at: Date.now(), body: out };
  return out;
}

async function readJSON(req) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return { err: json(413, { error: `分片超过 ${MAX_BODY >> 20} MB` }) };
  const text = await req.text();
  if (text.length > MAX_BODY) return { err: json(413, { error: `分片超过 ${MAX_BODY >> 20} MB` }) };
  try { return { body: JSON.parse(text), text }; } catch { return { err: json(400, { error: '不是合法 JSON' }) }; }
}

async function authenticate(env, account, passphrase) {
  if (!ACCOUNT_RE.test(account ?? '')) return false;
  if (typeof passphrase !== 'string' || passphrase.length < 4) return false;
  const rec = await env.ACCOUNTS.get(`acct:${account}`, 'json');
  return verifyPassphrase(passphrase, rec);
}

const text = (body) => new Response(body, {
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && path === '/health') return json(200, { ok: true, repo: env.GH_REPO });
      if (req.method === 'GET' && path === '/lite.ps1') return text(LITE_PS1.replaceAll('__INBOX_URL__', url.origin));
      if (req.method === 'GET' && path === '/lite.bat') {
        // .bat 里 CRLF 是硬要求：cmd 对 LF 结尾的文件会吞掉某些行
        return new Response(LITE_BAT.replaceAll('__INBOX_URL__', url.origin).replace(/\r?\n/g, '\r\n'), {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="MiraQuota-Lite.bat"',
            'cache-control': 'no-store',
          },
        });
      }
      if (req.method === 'POST' && path === '/register') {
        const { body, err } = await readJSON(req); if (err) return err;
        const { account, passphrase, invite } = body ?? {};
        if (!ACCOUNT_RE.test(account ?? '')) return json(400, { error: '名字只能是小写字母、数字、连字符，1–24 位' });
        if (typeof passphrase !== 'string' || passphrase.length < 4) return json(400, { error: '口令至少 4 位' });
        if (!env.INVITE_CODE || invite !== env.INVITE_CODE) return json(403, { error: '邀请码不对' });
        // 名字唯一：已有就拒绝，不覆盖、不合并（服务端只能有一个这个名字）
        if (await env.ACCOUNTS.get(`acct:${account}`)) return json(409, { error: '这个名字已经有人用了，换一个' });
        await env.ACCOUNTS.put(`acct:${account}`, JSON.stringify({ ...(await hashPassphrase(passphrase)), createdAt: Date.now() }));
        return json(201, { ok: true, account });
      }
      if (req.method === 'POST' && path === '/login') {
        const { body, err } = await readJSON(req); if (err) return err;
        return (await authenticate(env, body?.account, body?.passphrase))
          ? new Response(null, { status: 204 })
          : json(401, { error: '名字或口令不对' });
      }
      if (req.method === 'PUT' && path === '/shard') {
        const account = req.headers.get('x-account') ?? '';
        if (!(await authenticate(env, account, req.headers.get('x-passphrase')))) return json(401, { error: '名字或口令不对' });
        const { body, text: raw, err } = await readJSON(req); if (err) return err;
        const why = validateShard(body, account);
        if (why) return json(400, { error: why });
        const gapKey = `last:${account}:${body.installId}`;
        const last = Number(await env.ACCOUNTS.get(gapKey)) || 0;
        if (Date.now() - last < MIN_UPLOAD_GAP_MS) return json(429, { error: '上传太频繁，稍后再试' });
        await publishShard(env, branchFor(account, body.installId), raw);
        await env.ACCOUNTS.put(gapKey, String(Date.now()), { expirationTtl: 3600 });
        shardsCache.at = 0;
        return new Response(null, { status: 204 });
      }
      if (req.method === 'GET' && path === '/shards') return json(200, await listShards(env));
      return json(404, { error: 'no such endpoint' });
    } catch (e) {
      return json(502, { error: String(e?.message ?? e).slice(0, 300) });
    }
  },
};
