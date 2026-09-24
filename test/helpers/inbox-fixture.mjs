/**
 * 多机测试的公共夹具：一个冒充 Worker 的本地收件口（真 HTTP）+ 指向它的 sync.json。
 *
 * 语义与 inbox/worker.mjs 一致：内存账号表、分片表、流水表，校验走 inbox/shared.mjs 同一套判据。
 * 从前多机测试拿本地 hub 当远端；hub 通道 2026-09-24 下线（账号额度改由 fleet-dao 统一读），
 * 收件口是唯一现役通道，测的东西（分片发布/读取、去重、状态机）一个字没变。
 */
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateShard, validateJournal, branchFor } from '../../inbox/shared.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mq-inboxfix-'));

/**
 * 起一个本地收件口。返回 { url, accounts, shards, journals, log, close }。
 *
 * 传了测试上下文 `t` 就顺手注册收尾：**断言失败时也必须关**——HTTP 服务器挂着不关，
 * 事件循环不会退出，测试跑完了进程也不退（实测：单条失败 → 整轮挂死，看起来像超时）。
 */
export function fakeInbox({ invite = 'code', t = null } = {}) {
  const accounts = new Map();
  const shards = new Map();
  const journals = new Map();
  const log = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : null;
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj == null ? '' : JSON.stringify(obj)); };
    log.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/register') {
      if (body.invite !== invite) return send(403, { error: '邀请码不对' });
      if (accounts.has(body.account)) return send(409, { error: '这个名字已经有人用了，换一个' });
      accounts.set(body.account, body.passphrase);
      return send(201, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/login') {
      return accounts.get(body.account) === body.passphrase ? send(204) : send(401, { error: '名字或口令不对' });
    }
    if (req.method === 'PUT' && req.url === '/shard') {
      const acct = req.headers['x-account'];
      if (accounts.get(acct) !== req.headers['x-passphrase']) return send(401, { error: '名字或口令不对' });
      const why = validateShard(body, acct);
      if (why) return send(400, { error: why });
      shards.set(branchFor(acct, body.installId), body);
      return send(204);
    }
    if (req.method === 'GET' && req.url === '/shards') return send(200, [...shards.values()]);
    // 流水明细：同一套鉴权；GET 只回**本账号**的（明细里有会话 id 与工作区路径）
    if (req.method === 'PUT' && req.url === '/journal') {
      const acct = req.headers['x-account'];
      if (accounts.get(acct) !== req.headers['x-passphrase']) return send(401, { error: '名字或口令不对' });
      const why = validateJournal(body);
      if (why) return send(400, { error: why });
      journals.set(`${acct}--${body.installId.slice(0, 12)}`, { ...body, account: acct });
      return send(204);
    }
    if (req.method === 'GET' && req.url === '/journals') {
      const acct = req.headers['x-account'];
      if (accounts.get(acct) !== req.headers['x-passphrase']) return send(401, { error: '名字或口令不对' });
      return send(200, [...journals.values()].filter((j) => j.account === acct));
    }
    send(404, { error: 'no such endpoint' });
  });
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  if (typeof t?.after === 'function') t.after(close);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, accounts, shards, journals, log, close });
  }));
}

/**
 * 写一份指向该收件口的 sync.json（账号直接登记进假 Worker，省掉登录那一步），返回路径。
 * 名字要过 ACCOUNT_RE（小写字母、数字、连字符）。`extra` 用来配 intervalSec 之类。
 */
export function inboxConfig(box, name, { account = name, passphrase = `pass-${name}`, extra = {} } = {}) {
  if (box) box.accounts.set(account, passphrase);
  const file = join(dir, `${name}-sync.json`);
  writeFileSync(file, JSON.stringify({ inbox: box?.url ?? 'http://127.0.0.1:9', account, passphrase, ...extra }));
  return file;
}

/** 同一批测试共用的临时目录（各用例自己挑文件名，互不撞）。 */
export const fixtureDir = dir;
