/**
 * 多机测试的公共夹具：一个真 HTTP hub + 指向它的 sync.json。
 *
 * 从前这些测试拿本地 bare git 仓当远端（`git init --bare` + machine/* 分支）。git 通道
 * 2026-09-23 退役并删掉了（用户：「不要存 Github，占项目大小和烧 cpu」），夹具换成 hub——
 * 它本来就是现役通道，测的东西（分片发布/读取、去重、状态机）一个字没变。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hub } from '../../server/hub.mjs';

let seq = 0;
const dir = mkdtempSync(join(tmpdir(), 'mq-hubfix-'));

/**
 * 起一个本地 hub。返回 { hub, base, token, close }；base 是客户端要填进 sync.json 的地址。
 *
 * 传了测试上下文 `t` 就顺手注册收尾：**断言失败时也必须关**——HTTP 服务器挂着不关，
 * 事件循环不会退出，测试跑完了进程也不退（实测：单条失败 → 整轮挂死，看起来像超时）。
 */
export async function startHub(t, { token = 'sekrit' } = {}) {
  const hub = new Hub({ dataDir: join(dir, `d${++seq}`), token });
  const srv = await hub.listen(0);
  const api = { hub, base: `http://127.0.0.1:${srv.address().port}`, token, close: () => hub.close() };
  if (typeof t?.after === 'function') t.after(() => hub.close());
  return api;
}

/** 写一份指向该 hub 的 sync.json，返回路径。`extra` 用来配 intervalSec/quotaIntervalSec 之类。 */
export function hubConfig(name, base, { token = 'sekrit', extra = {} } = {}) {
  const file = join(dir, `${name}-sync.json`);
  writeFileSync(file, JSON.stringify({ hub: base, token, ...extra }));
  return file;
}

/** 同一批测试共用的临时目录（各用例自己挑文件名，互不撞）。 */
export const fixtureDir = dir;
