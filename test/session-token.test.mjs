/**
 * 会话令牌解析：环境块 → { port, path, token }。
 *
 * 为什么值得一条测试：这个正则是「服务器那台能不能自己读 /v1/limits」的全部把关（见
 * session-token.mjs 头注的 2026-09-08 实咬）。写错一个字符的后果不是报错，而是静默
 * 退回「没有令牌」——面板照样能画，只是额度永远是别的机器几小时前读到的那份。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSessionEnv } from '../provider/lib/session-token.mjs';

const NUL = '\0';

test('新版：令牌在 URL 路径里', () => {
  const block = ['PATH=/usr/bin', 'ANTHROPIC_BASE_URL=http://127.0.0.1:42403/Kw7VpgO-ff-JeVH98FZQI2', 'HOME=/root'].join(NUL);
  assert.deepEqual(parseSessionEnv(block), { port: 42403, path: '/Kw7VpgO-ff-JeVH98FZQI2', token: null });
});

test('旧版：路径没有，令牌在 ANTHROPIC_AUTH_TOKEN', () => {
  const block = ['ANTHROPIC_BASE_URL=http://127.0.0.1:9931', 'ANTHROPIC_AUTH_TOKEN=hdr-token'].join(NUL);
  assert.deepEqual(parseSessionEnv(block), { port: 9931, path: null, token: 'hdr-token' });
});

test('两代并存时两份都带回去，由 engine 决定用哪份', () => {
  const block = ['ANTHROPIC_BASE_URL=http://127.0.0.1:42403/tok-path', 'ANTHROPIC_AUTH_TOKEN=up-cred'].join(NUL);
  assert.deepEqual(parseSessionEnv(block), { port: 42403, path: '/tok-path', token: 'up-cred' });
});

test('尾部斜杠削掉——engine 拼 /v1/limits 时不许出现双斜杠', () => {
  assert.equal(parseSessionEnv(`ANTHROPIC_BASE_URL=http://127.0.0.1:42403/tok/${NUL}X=1`).path, '/tok');
});

test('不是会话进程：没有 BASE_URL，或指向的不是回环', () => {
  assert.equal(parseSessionEnv(`PATH=/usr/bin${NUL}HOME=/root`), null);
  // 服务器上真实存在这样一个进程（reclaude 直连 hub 域名），不该被当成会话进程
  assert.equal(parseSessionEnv('ANTHROPIC_BASE_URL=https://156.224.28.95.sslip.io'), null);
});

test('回环但既没路径也没头令牌：拿不到令牌等于没发现', () => {
  assert.equal(parseSessionEnv('ANTHROPIC_BASE_URL=http://127.0.0.1:9931'), null);
});

test('NUL 是值的边界：不许把下一个变量吞进令牌', () => {
  const block = `ANTHROPIC_BASE_URL=http://127.0.0.1:42403${NUL}ANTHROPIC_AUTH_TOKEN=abc${NUL}LANG=C.UTF-8`;
  assert.deepEqual(parseSessionEnv(block), { port: 42403, path: null, token: 'abc' });
});
