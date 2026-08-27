/**
 * 生成应用图标（纯 Node，无外部依赖）：一枚环形仪表盘。
 *   build/icon.png      256×256，electron-builder 转 ico 用
 *   app/assets/tray.png 32×32，托盘
 * 用法： node scripts/gen-icon.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgbaAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = rgbaAt(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;   // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 环形仪表盘：12 点起顺时针 72% 亮蓝弧，其余暗轨，中心镂空。 */
function gauge(size) {
  const c = (size - 1) / 2;
  const outer = size * 0.46, inner = size * 0.27;
  const fillTo = 0.72 * Math.PI * 2;
  const aa = 1.2 * (size / 32);   // 抗锯齿过渡带
  return png(size, (x, y) => {
    const dx = x - c, dy = y - c;
    const r = Math.hypot(dx, dy);
    // 环带覆盖度（边缘线性过渡做抗锯齿）
    const cov = Math.max(0, Math.min(1, (outer - r) / aa)) * Math.max(0, Math.min(1, (r - inner) / aa));
    if (cov <= 0) return [0, 0, 0, 0];
    let ang = Math.atan2(dx, -dy);           // 12 点为 0，顺时针
    if (ang < 0) ang += Math.PI * 2;
    const lit = ang <= fillTo;
    const [r8, g8, b8] = lit ? [76, 141, 255] : [70, 76, 90];
    return [r8, g8, b8, Math.round(cov * 255)];
  });
}

mkdirSync(join(ROOT, 'build'), { recursive: true });
mkdirSync(join(ROOT, 'app', 'assets'), { recursive: true });
writeFileSync(join(ROOT, 'build', 'icon.png'), gauge(256));
writeFileSync(join(ROOT, 'app', 'assets', 'tray.png'), gauge(32));
console.log('图标已生成：build/icon.png (256) · app/assets/tray.png (32)');
