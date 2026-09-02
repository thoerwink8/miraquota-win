/**
 * 收件口的纯函数：Worker 与测试共用。放这里是因为 worker.mjs 顶部 import 了 .ps1/.bat
 * 文本模块，Node 直接加载不了；纯逻辑抽出来，测试就能覆盖到校验与哈希。
 */
const PBKDF2_ITER = 100_000;
const MAX_ROWS = 40_000;
export const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hashPassphrase(passphrase, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return { salt: b64(salt), hash: b64(bits) };
}

export async function verifyPassphrase(passphrase, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  const { hash } = await hashPassphrase(passphrase, unb64(rec.salt));
  // 常数时间比较：长度相同才比，逐字节异或累加
  const a = unb64(hash), b = unb64(rec.hash);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/**
 * 分片校验。两种形态都收：
 *  v1 聚合态（完整应用）：buckets/scoped/family/unpriced 是「键→数」的对象；
 *  v2 原始行（轻客户端）：rows 是 [{t,m,i,o,cr,cw,src?}]，定价交给读它的那一端。
 * 返回 null 表示通过，否则是一句人话原因。
 */
export function validateShard(shard, account) {
  if (!shard || typeof shard !== 'object') return '不是 JSON 对象';
  if (shard.schemaVersion !== 1 && shard.schemaVersion !== 2) return 'schemaVersion 只认 1 或 2';
  if (typeof shard.machineId !== 'string' || !shard.machineId) return '缺 machineId';
  if (typeof shard.installId !== 'string' || !/^[a-f0-9]{8,32}$/.test(shard.installId)) return 'installId 要是 8–32 位十六进制';
  if (shard.account !== account) return '分片里的 account 与登录身份不一致';
  if (typeof shard.generatedAt !== 'number') return '缺 generatedAt';
  if (!shard.coverage || typeof shard.coverage.fromSec !== 'number' || typeof shard.coverage.toSec !== 'number') return '缺 coverage';
  const numMap = (o) => o == null || (typeof o === 'object' && !Array.isArray(o)
    && Object.values(o).every((v) => typeof v === 'number' && Number.isFinite(v)));
  if (shard.schemaVersion === 1) {
    for (const k of ['buckets', 'scoped', 'family', 'unpriced']) if (!numMap(shard[k])) return `${k} 不是「键→数」`;
    if (!shard.buckets) return '缺 buckets';
    return null;
  }
  if (!Array.isArray(shard.rows)) return 'v2 分片缺 rows';
  if (shard.rows.length > MAX_ROWS) return `rows 超过 ${MAX_ROWS} 行`;
  for (const r of shard.rows) {
    if (typeof r?.t !== 'number' || typeof r?.m !== 'string' || !r.m) return 'rows 里有行缺 t/m';
    for (const k of ['i', 'o', 'cr', 'cw']) if (r[k] != null && typeof r[k] !== 'number') return `rows.${k} 不是数`;
  }
  return null;
}

/** 分支名：account + installId 前 12 位。同一个人多台机器互不覆盖，重装换 installId 就是新机器。 */
export function branchFor(account, installId) {
  return `machine/${account}--${installId.slice(0, 12)}`;
}
