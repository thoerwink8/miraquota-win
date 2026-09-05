/**
 * Hub 的落盘：一台机器一个分片文件，外加一份账号额度快照。
 *
 * 刻意不上数据库。这里存的东西有三个特点——总量小（每台机器一份聚合态，几十 KB）、
 * 永远整份覆盖（分片就是「这台机器此刻的全貌」，没有增量更新）、丢了能自愈
 * （各机下一轮就重新推上来）。JSON 文件正好，省掉一个要备份、要升级、会挂的组件。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 分片保留期：盖住 7d 窗口并留余量，与 CostLedger 的 RETENTION 同口径。 */
export const SHARD_TTL = 8 * 86400;
/**
 * 额度快照到达时最多能有多老。放得比推送间隔（quotaIntervalSec，默认 120 秒）宽得多，
 * 是为了容下时钟偏差与网络慢包；卡得住的是「离线很久的机器上线后回放一份陈年快照」。
 */
export const MAX_PUSH_AGE = 600;
/** 文件名安全的机器键：分片自报的 installId/machineId 不可信，落盘前必须洗。 */
export const safeKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 64);

/** 整份覆盖式写入：先写临时文件再改名，读的人永远看到完整 JSON 或旧的那份。 */
function writeAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, file);
}

export class HubStore {
  constructor(dir) {
    this.dir = dir;
    this.shardDir = join(dir, 'shards');
    this.limitsFile = join(dir, 'limits.json');
    mkdirSync(this.shardDir, { recursive: true });
  }

  /**
   * 收下一台机器的分片。键取 installId（重装即新机器），没有就退回主机名——
   * 与客户端 #isForeign 的判据一致，两边对同一台机器的认定不会分家。
   * @returns 落盘用的键
   */
  putShard(shard, { ip = null, at = Date.now() / 1000 } = {}) {
    const key = safeKey(shard.installId || shard.machineId) || 'machine';
    // receivedAt / ip 是服务端观测，不进分片本体：分片是那台机器的自述，掺进服务端的话
    // 以后就分不清哪句是谁说的。ip 只作显示，身份一律认 installId（IP 天天变）。
    writeAtomic(join(this.shardDir, `${key}.json`), { shard, receivedAt: at, ip });
    return key;
  }

  /** 全部在架分片；过期的顺手删掉（读的时候清，省一个定时任务）。 */
  shards(now = Date.now() / 1000) {
    const out = [];
    let files;
    try { files = readdirSync(this.shardDir); } catch { return out; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const path = join(this.shardDir, f);
      try {
        const rec = JSON.parse(readFileSync(path, 'utf8'));
        const at = rec?.shard?.generatedAt ?? rec?.receivedAt ?? 0;
        if (now - at > SHARD_TTL) { unlinkSync(path); continue; }
        out.push({ ...rec, key: f.slice(0, -5) });
      } catch {
        // 坏文件（写到一半断电、手改坏了）：删掉，那台机器下一轮会重新推上来
        try { unlinkSync(path); } catch { /* 删不掉就下轮再说 */ }
      }
    }
    return out;
  }

  /**
   * 账号额度快照。只留最新的一份——它是账号级的，谁读到的都是同一份，
   * 存多份只会带来「该信谁」这个本来不存在的问题。
   *
   * **新旧按服务器自己的时钟判，不按发送方的 capturedAt。** 各机时钟不齐是常态
   * （实测本机 Windows 比两台服务器慢 48 秒）；按发送方时钟排序，慢钟那台的新读数会被
   * 快钟那台的旧读数长期挡住，「随时同步」就成了「随那台钟快的机器」。收到即最新——
   * 额度是读到就立刻推的，到达顺序≈读取顺序，而且这一路只用一个时钟量。
   *
   * capturedAt 仍然收下并原样存：它是**显示龄期**用的，也是唯一能识破「离线很久的机器
   * 把一份陈年快照推上来」的依据——超过 MAX_PUSH_AGE 一律不收。
   * @returns true 表示这份被采纳了
   */
  putLimits(limits, { machineId = null, at = Date.now() / 1000 } = {}) {
    const age = at - (limits.capturedAt ?? 0);
    if (age > MAX_PUSH_AGE) return false;      // 陈年快照回放：那台机器离线太久，别拿它覆盖
    writeAtomic(this.limitsFile, { ...limits, machineId, receivedAt: at });
    return true;
  }

  limits() {
    try { return JSON.parse(readFileSync(this.limitsFile, 'utf8')); } catch { return null; }
  }

  /** 数据目录体积，运维那行日志用。 */
  bytes() {
    let n = 0;
    try { for (const f of readdirSync(this.shardDir)) n += statSync(join(this.shardDir, f)).size; } catch { /* 读不到就报 0 */ }
    try { n += statSync(this.limitsFile).size; } catch { /* 还没有额度快照 */ }
    return n;
  }
}
