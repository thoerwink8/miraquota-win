/**
 * Hub 客户端：面板从服务器拿算好的 payload，本机不再自己算一遍。
 *
 * 走 SSE（`GET /stream`）而不是轮询——服务器有新数据就推，秒级；轮询要么慢要么白问。
 * 断了自己退避重连，重连期间面板退回本机自算的那份（见 merge），不白屏。
 *
 * **不是所有字段都该听服务器的。** 账号级的东西（额度窗口、单价、今天、档位倍率）
 * 服务器算得比本机全，因为它手里有全部机器的账本；机器级的东西（这台机器跑多快、
 * 这台机器装了哪些模型、这台机器的同步状态）只有本机答得了，服务器上压根没有。
 * 混着取，取错一边就是把别人的速度当成自己的、或者把自己的账本当成全账号的。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_FILE = join(homedir(), '.miraquota', 'sync.json');
/** 超过这个龄期就当服务器失联，退回本机自算（服务器 25 秒一次心跳，两次没到才算断）。 */
export const HUB_STALE_AFTER = 70;
const RECONNECT_MIN = 3_000;
const RECONNECT_MAX = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * 只有这几个字段从本机取，其余一律听服务器的。
 *
 * 逐个说清为什么，否则以后有人往里加字段时只能猜：
 *  - speed    这台机器自己的实测速度（首字延迟、出字速率），服务器上没有任何一台机器的
 *             实时速度，它只有分片里那份最多落后一轮的快照；
 *  - roster   对表 ~/.mirasim/setting.json 的已启用模型，是**这台机器**的配置；
 *  - sync     这台机器与服务器的连接状态，本来就是本机的事；
 *  - buckets  本机账本的分钟桶数，排查用的本机读数；
 *  - pricing  价目表来源，本机的。
 */
export const LOCAL_FIELDS = ['speed', 'roster', 'sync', 'buckets', 'pricing'];

/**
 * 服务器那份 + 本机那份 → 面板真正画的那份。
 * 服务器没有／过期时原样返回本机那份（降级路径，行为与没有 hub 时逐字一致）。
 * @param hubPayload 服务器算好的（可能是 null）
 * @param local      本机 Engine 算的
 * @param at         hubPayload 收到的时刻（秒）；判过期用
 */
export function merge(hubPayload, local, at = null, now = Date.now() / 1000) {
  if (!hubPayload || (at != null && now - at > HUB_STALE_AFTER)) return local;
  const out = { ...hubPayload };
  for (const k of LOCAL_FIELDS) {
    if (local?.[k] != null) out[k] = local[k];
    else delete out[k];
  }
  // 面板据此说明「这个数是服务器算的」——不说的话，用户看到本机 Mirasim 没开却有精确值
  // 会以为是哪里出了错。ageSeconds 给的是这份 payload 在服务器上生成后过了多久。
  out.fromHub = { ageSeconds: at != null ? Math.max(0, now - at) : 0, machines: hubPayload.hub?.machines?.length ?? 0 };
  return out;
}

/** sync.json 里的 hub 配置；没配就是没启用。 */
export function readHubConfig(file = CONFIG_FILE) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof c?.hub !== 'string' || !c.hub.trim()) return null;
    return { hub: c.hub.trim().replace(/\/+$/, ''), token: c.token ?? null };
  } catch { return null; }
}

export class HubClient {
  /**
   * @param opts.configFile sync.json 路径（测试注入）
   * @param opts.onPayload  收到新 payload 时回调（面板据此立刻重画，不等心跳）
   */
  constructor({ configFile = CONFIG_FILE, onPayload = null } = {}) {
    this.config = readHubConfig(configFile);
    this.configFile = configFile;
    this.onPayload = onPayload;
    this.payload = null;
    this.receivedAt = null;
    this.state = this.config ? 'connecting' : 'off';
    this.error = null;
    this.#stopped = true;
    this.#delay = RECONNECT_MIN;
  }

  #stopped; #delay; #ctrl; #timer;

  get enabled() { return !!this.config; }

  /** 配置变了（用户刚在面板上填了服务器地址）：重读并重连。 */
  reload() {
    const next = readHubConfig(this.configFile);
    const same = JSON.stringify(next) === JSON.stringify(this.config);
    this.config = next;
    if (same) return false;
    this.payload = null; this.receivedAt = null; this.error = null;
    this.state = next ? 'connecting' : 'off';
    this.stop();
    if (next) this.start();
    return true;
  }

  start() {
    if (!this.config || !this.#stopped) return;
    this.#stopped = false;
    this.#loop();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    try { this.#ctrl?.abort(); } catch { /* 已断 */ }
    this.#ctrl = null;
  }

  /** 面板每跳拿一次：服务器那份 + 本机那份合成一份。 */
  merge(local, now = Date.now() / 1000) {
    return merge(this.payload, local, this.receivedAt, now);
  }

  /**
   * 连上就一直读，断了退避重连。整个循环自吞错误——服务器不可用时面板照旧用本机那份，
   * 不该因为一个可选的数据源就报错到用户脸上。
   */
  async #loop() {
    while (!this.#stopped && this.config) {
      try {
        await this.#connect();
        this.#delay = RECONNECT_MIN;    // 正常收过数据，下次断了从最短间隔重来
      } catch (e) {
        if (this.#stopped) return;
        this.error = String(e?.message || e).slice(0, 200);
        this.state = 'error';
      }
      if (this.#stopped) return;
      await new Promise((r) => { this.#timer = setTimeout(r, this.#delay); });
      this.#delay = Math.min(this.#delay * 2, RECONNECT_MAX);
    }
  }

  async #connect() {
    this.#ctrl = new AbortController();
    const headers = { accept: 'text/event-stream', ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) };
    // 只给「连上」设超时，连上之后这条流本来就该一直开着
    const timer = setTimeout(() => { try { this.#ctrl.abort(); } catch { /* 已断 */ } }, CONNECT_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(`${this.config.hub}/stream`, { headers, signal: this.#ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    this.state = 'ok'; this.error = null;

    // SSE 按空行分帧；跨 chunk 的半条要留在 buf 里等下一块
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!this.#stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim()).join('');
        if (!data) continue;         // 心跳帧（': beat'）没有 data，跳过
        try {
          this.payload = JSON.parse(data);
          this.receivedAt = Date.now() / 1000;
          this.onPayload?.(this.payload);
        } catch { /* 半条坏帧：丢掉，等下一帧 */ }
      }
    }
    throw new Error('连接被对端关闭');
  }
}
