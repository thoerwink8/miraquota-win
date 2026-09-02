/**
 * MiraQuota 账本收件口（Cloudflare Worker）。
 *
 * 为什么有它（2026-09-02 用户拍板）：共享额度的人没有 GitHub，也不想每加一个人就去开令牌。
 * 客户端零仓库凭据，只带「名字 + 自设口令 + 一次性邀请码」，都只在首次输入。
 *
 * 分片存哪：**直接存 KV**，不写 GitHub 仓。早先设计是 Worker 持一把仓库令牌代写，但细粒度
 * 令牌只能在网页上手工建、一年一换——正是用户不想做的那类事。存 KV 后 Worker 一个秘密都
 * 不需要（邀请码除外），部署只剩「登录 Cloudflare 点一次同意」。git 通道的机器读账本时
 * 顺带也来这里拿一次分片（只读、无鉴权），两条通道的人在同一张多机页上。
 *
 * 身份模型：机器靠随机 installId；人靠自报名字 + 自设口令（PBKDF2 哈希存 KV）。
 * 名字全局唯一——同一个名字只能注册一次（用户 2026-09-02：服务端不能有重名），
 * 之后只有知道口令的人能以这个名字上传。名字是自报的，Worker 保证不了第一次报的是真的。
 *
 * 接口：
 *   POST /register {account, passphrase, invite}   → 201 / 403 邀请码错 / 409 名字已占
 *   POST /login    {account, passphrase}           → 204 / 401
 *   PUT  /shard    头 x-account / x-passphrase，体分片 JSON（≤3MB） → 204 / 401 / 400 / 429
 *   GET  /shards                                   → 全部分片数组
 *   GET  /lite.bat  GET /lite.ps1                  → 双击即用的轻客户端及其脚本
 *   GET  /health
 * 环境：INVITE_CODE（秘密）、ACCOUNTS（KV：账号 + 分片）。
 * KV 键：acct:<名字> → 口令哈希；shard:<名字>--<installId 前 12 位> → 分片 JSON；last:… → 限频。
 */
import LITE_PS1 from './lite.ps1';
import LITE_BAT from './lite.bat';

import { ACCOUNT_RE, hashPassphrase, verifyPassphrase, validateShard, branchFor } from './shared.mjs';

const MAX_BODY = 3 << 20;
const MIN_UPLOAD_GAP_MS = 45_000;
const SHARD_TTL_SEC = 14 * 86400;   // 两周没再上传的机器自动消失（账本本来只留 8 天）

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
});
const text = (body) => new Response(body, {
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
});

/** 分片的 KV 键与仓库分支名同构：machine/<名字>--<installId12> → shard:<名字>--<installId12>。 */
const shardKey = (account, installId) => 'shard:' + branchFor(account, installId).slice('machine/'.length);

async function readJSON(req) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return { err: json(413, { error: `分片超过 ${MAX_BODY >> 20} MB` }) };
  const raw = await req.text();
  if (raw.length > MAX_BODY) return { err: json(413, { error: `分片超过 ${MAX_BODY >> 20} MB` }) };
  try { return { body: JSON.parse(raw), raw }; } catch { return { err: json(400, { error: '不是合法 JSON' }) }; }
}

async function authenticate(env, account, passphrase) {
  if (!ACCOUNT_RE.test(account ?? '')) return false;
  if (typeof passphrase !== 'string' || passphrase.length < 4) return false;
  const rec = await env.ACCOUNTS.get(`acct:${account}`, 'json');
  return verifyPassphrase(passphrase, rec);
}

async function listShards(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.ACCOUNTS.list({ prefix: 'shard:', cursor });
    for (const k of page.keys) {
      try {
        const s = await env.ACCOUNTS.get(k.name, 'json');
        if (s && s.machineId) out.push(s);
      } catch { /* 单个分片坏不影响其余 */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && path === '/health') return json(200, { ok: true, store: 'kv' });
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
        const { body, raw, err } = await readJSON(req); if (err) return err;
        const why = validateShard(body, account);
        if (why) return json(400, { error: why });
        const gapKey = `last:${account}:${body.installId}`;
        const last = Number(await env.ACCOUNTS.get(gapKey)) || 0;
        if (Date.now() - last < MIN_UPLOAD_GAP_MS) return json(429, { error: '上传太频繁，稍后再试' });
        await env.ACCOUNTS.put(shardKey(account, body.installId), raw, { expirationTtl: SHARD_TTL_SEC });
        await env.ACCOUNTS.put(gapKey, String(Date.now()), { expirationTtl: 3600 });
        return new Response(null, { status: 204 });
      }
      if (req.method === 'GET' && path === '/shards') return json(200, await listShards(env));
      return json(404, { error: 'no such endpoint' });
    } catch (e) {
      return json(502, { error: String(e?.message ?? e).slice(0, 300) });
    }
  },
};
