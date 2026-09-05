#!/usr/bin/env node
/**
 * 把 MiraQuota Hub 装到一台各机都连得上的服务器上（一条命令，可重复跑）。
 *
 *   node scripts/deploy-hub.mjs --host myserver
 *
 * 它做五件事：探条件（node 22+，nginx，证书）、送 server/ 与 provider/、
 * 生成一次性 token、装 systemd 服务 miraquota-hub、在现有 nginx 里挂一个 /mq/ 反代。
 *
 * 幂等：重复跑只更新代码并重启；已有的 token 与数据目录不动（不会把各机踢下线）。
 * nginx 那段用「标记块」整块替换，改配置永远只动自己那几行，改完先 nginx -t 再 reload——
 * 那台机器上还跑着别人的服务（newapi），配置写坏就是把它一起弄停。
 */
import { execFile, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'miraquota-hub';
const DEFAULT_PORT = 4331;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

if (flag('help') || !opt('host')) {
  console.log(`用法 node scripts/deploy-hub.mjs --host <ssh 别名或 user@ip> [选项]

  --host <目标>    必填。要能免密 ssh 上去
  --dir <路径>     代码落点，默认 /opt/miraquota-hub
  --data <路径>    数据目录（分片、额度快照），默认 /var/lib/miraquota-hub
  --port <端口>    只监听 127.0.0.1 的这个端口，默认 ${DEFAULT_PORT}（外面走 nginx）
  --base <路径>    对外路径前缀，默认 /mq
  --site <文件>    要挂反代的 nginx 站点，默认自动找 sites-enabled 里带证书的那个
  --no-nginx       只装服务，不碰 nginx（自己手配反代时用）
  --uninstall      停掉并删除服务、代码、nginx 那一段（数据目录保留）

装完打印 sync.json 该怎么填。token 只在装的时候打印一次，之后去那台机器的
<data>/config.json 里看。`);
  process.exit(opt('host') ? 0 : 1);
}

const HOST = opt('host');
const DIR = opt('dir', '/opt/miraquota-hub');
const DATA = opt('data', '/var/lib/miraquota-hub');
const PORT = Number(opt('port', DEFAULT_PORT));
const BASE = ('/' + String(opt('base', '/mq')).replace(/^\/+|\/+$/g, '')).replace(/\/$/, '');
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25'];
const say = (m) => console.log(m);
const MARK_A = '# >>> miraquota-hub >>>';
const MARK_B = '# <<< miraquota-hub <<<';

/** 远端执行一段 sh：脚本走 stdin，省掉一层引号转义。 */
function remote(script) {
  return new Promise((resolve, reject) => {
    const p = execFile('ssh', [...SSH, HOST, 'bash -s'], { maxBuffer: 64 << 20, windowsHide: true },
      (err, stdout, stderr) => err ? reject(new Error(String(stderr || err).trim())) : resolve(String(stdout)));
    p.stdin.end(script);
  });
}

if (flag('uninstall')) {
  await remote(`set -e
S=$([ "$(id -u)" = 0 ] || echo sudo)
$S systemctl disable --now ${SERVICE} 2>/dev/null || true
$S rm -f /etc/systemd/system/${SERVICE}.service
$S systemctl daemon-reload
$S rm -rf ${DIR}
for f in /etc/nginx/sites-enabled/*; do
  [ -f "$f" ] || continue
  grep -q '${MARK_A}' "$f" || continue
  $S sed -i '/${MARK_A}/,/${MARK_B}/d' "$f"
done
$S nginx -t && $S systemctl reload nginx || true`);
  say(`已删除 ${HOST} 上的 hub 服务、代码与 nginx 段；数据目录 ${DATA} 保留（要彻底清就手动删）`);
  process.exit(0);
}

/* ---------------- 1. 那台机器够不够条件 ---------------- */
const probe = await remote(`
node -v 2>/dev/null || echo NO_NODE
hostname
command -v nginx >/dev/null && echo HAS_NGINX || echo NO_NGINX
[ -f "${DATA}/config.json" ] && echo HAS_CFG || echo NO_CFG
ls /etc/nginx/sites-enabled 2>/dev/null | tr '\\n' ' '
`);
const lines = probe.split(/\r?\n/).map((s) => s.trim());
let nodeVer = lines[0];
const hostShort = (lines[1] ?? 'server').split('.')[0];
const hasNginx = lines.includes('HAS_NGINX');
const hasCfg = lines.includes('HAS_CFG');

// node 22 是硬门槛（provider 用了全局 fetch 与新的 URL 行为）。
// 那台机器上的 node 很可能是给别的服务用的——**绝不动它**：升级系统 node 去伺候一个
// 监控面板，代价是把人家的网关一起赌上。装一份独立的官方 tarball 到 /opt/node22，
// systemd 单元直接指它，系统 PATH 一个字节都不改。
let NODE_BIN = 'node';
if (Number(/v(\d+)/.exec(nodeVer)?.[1] ?? 0) < 22) {
  say(`${HOST} 的 node 是 ${nodeVer === 'NO_NODE' ? '没有' : nodeVer}，另装一份 22 到 /opt/node22（不动现有的）`);
  const out = await remote(`set -e
S=$([ "$(id -u)" = 0 ] || echo sudo)
if [ ! -x /opt/node22/bin/node ]; then
  case "$(uname -m)" in
    x86_64) A=x64 ;; aarch64|arm64) A=arm64 ;; *) echo "UNSUPPORTED_ARCH $(uname -m)"; exit 1 ;;
  esac
  V=v22.20.0
  cd /tmp
  curl -fsSLo node22.tar.xz "https://nodejs.org/dist/$V/node-$V-linux-$A.tar.xz"
  $S rm -rf /opt/node22 && $S mkdir -p /opt/node22
  $S tar -xJf node22.tar.xz -C /opt/node22 --strip-components=1
  rm -f node22.tar.xz
fi
/opt/node22/bin/node -v`);
  const v = out.trim().split(/\r?\n/).pop();
  if (!/^v2[2-9]/.test(v)) { console.error(`装 node 22 没成：${out.trim()}`); process.exit(1); }
  NODE_BIN = '/opt/node22/bin/node';
  nodeVer = `${v}（独立装在 /opt/node22，系统 node 未动）`;
}
say(`${HOST} · ${hostShort} · node ${nodeVer} · nginx ${hasNginx ? '有' : '没有'} · 配置 ${hasCfg ? '已有（不动）' : '待生成'}`);

/* ---------------- 2. 送代码：server/ + provider/，纯 Node 零依赖 ---------------- */
await remote(`mkdir -p ${DIR} ${DATA}`);
await new Promise((resolve, reject) => {
  const tar = spawn('tar', ['-cf', '-', 'server', 'provider'], { cwd: ROOT, windowsHide: true });
  const ssh = spawn('ssh', [...SSH, HOST, `tar -xf - -C ${DIR}`], { windowsHide: true });
  let err = '';
  tar.stderr.on('data', (d) => { err += d; });
  ssh.stderr.on('data', (d) => { err += d; });
  tar.stdout.pipe(ssh.stdin);
  ssh.on('error', reject);
  ssh.on('close', (code) => code === 0 ? resolve() : reject(new Error(`传代码失败（${code}）：${err.trim()}`)));
});
// hub.mjs 从 ../inbox/shared.mjs 借分片校验：两处对「什么是合法分片」必须同一个答案
await new Promise((resolve, reject) => {
  const tar = spawn('tar', ['-cf', '-', 'inbox/shared.mjs'], { cwd: ROOT, windowsHide: true });
  const ssh = spawn('ssh', [...SSH, HOST, `tar -xf - -C ${DIR}`], { windowsHide: true });
  tar.stdout.pipe(ssh.stdin);
  ssh.on('error', reject);
  ssh.on('close', (code) => code === 0 ? resolve() : reject(new Error(`传 inbox/shared.mjs 失败（${code}）`)));
});
say(`代码已同步到 ${HOST}:${DIR}`);

/* ---------------- 3. token 与 systemd ---------------- */
// token 只生成一次：重复跑不换，否则各机全部掉线还不知道为什么
const token = (await remote(`set -e
S=$([ "$(id -u)" = 0 ] || echo sudo)
$S mkdir -p ${DATA}
if [ ! -f ${DATA}/config.json ]; then
  T=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
  printf '{"token":"%s"}\\n' "$T" | $S tee ${DATA}/config.json >/dev/null
  $S chmod 600 ${DATA}/config.json
fi
$S cat ${DATA}/config.json`)).trim();
const TOKEN = JSON.parse(token).token;

await remote(`set -e
S=$([ "$(id -u)" = 0 ] || echo sudo)
$S tee /etc/systemd/system/${SERVICE}.service >/dev/null <<'UNIT'
[Unit]
Description=MiraQuota Hub (账本与账号额度的唯一真相)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN === 'node' ? '/usr/bin/env node' : NODE_BIN} ${DIR}/server/hub.mjs --data ${DATA} --port ${PORT} --host 127.0.0.1
Restart=always
RestartSec=5
# 只监听回环，外面一律走 nginx——这台机器上还有别人的服务，不多开一个公网口
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
$S systemctl daemon-reload
$S systemctl enable --now ${SERVICE}
sleep 2
$S systemctl is-active ${SERVICE}`);
say(`服务 ${SERVICE} 已启动（127.0.0.1:${PORT}）`);

/* ---------------- 4. nginx 反代 ---------------- */
let publicBase = null;
if (!flag('no-nginx') && hasNginx) {
  const site = opt('site') ?? (await remote(`
for f in /etc/nginx/sites-enabled/*; do
  [ -f "$f" ] || continue
  grep -q 'ssl_certificate ' "$f" && grep -q 'server_name' "$f" && echo "$f" && break
done`)).trim();
  if (!site) {
    say('nginx 里找不到带证书的站点，跳过反代（用 --site 指定，或 --no-nginx 自己配）');
  } else {
    const serverName = (await remote(`grep -m1 -oP 'server_name\\s+\\K[^;]+' ${site} | awk '{print $1}'`)).trim();
    // 标记块整块替换：只动自己这几行，别人的配置一个字节都不碰
    await remote(`set -e
S=$([ "$(id -u)" = 0 ] || echo sudo)
# 备份与中间文件都**不能**落在 sites-enabled 里：nginx include 的是 sites-enabled/*，
# 放那儿会立刻变成第二份生效配置（实咬一次：duplicate default server for 0.0.0.0:443）
$S mkdir -p /var/backups/nginx-miraquota
BAK=/var/backups/nginx-miraquota/$(basename ${site}).$(date +%s)
$S cp ${site} "$BAK"
$S sed -i '/${MARK_A}/,/${MARK_B}/d' ${site}
BLOCK=$(cat <<'NG'
    ${MARK_A}
    location ${BASE}/ {
        proxy_pass http://127.0.0.1:${PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE：不缓冲、不超时，否则 /stream 会被攒住或掐断
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        chunked_transfer_encoding off;
    }
    ${MARK_B}
NG
)
# 插到第一个带 ssl_certificate 的 server 块里：那是有证书的那个虚拟主机
$S awk -v block="$BLOCK" '
  !done && /ssl_certificate[ \\t]/ { print; print block; done=1; next } { print }
' ${site} | $S tee /tmp/mq-site.new >/dev/null
$S cp /tmp/mq-site.new ${site} && $S rm -f /tmp/mq-site.new
# 语法不过就把原文件放回去：这台机器上还跑着 newapi，配置留在坏状态，
# 下一次任何人 reload nginx 都会连它一起弄停
if ! $S nginx -t; then $S cp "$BAK" ${site}; echo "nginx -t 不过，已还原 $BAK"; exit 1; fi
$S systemctl reload nginx`);
    publicBase = `https://${serverName}${BASE}`;
    say(`nginx 已挂上 ${publicBase}（站点 ${site}，改动前已备份）`);
  }
}

/* ---------------- 5. 验一下真的通了 ---------------- */
const health = (await remote(`curl -s -m 8 http://127.0.0.1:${PORT}/health || echo FAIL`)).trim();
say(`本机探活 ${health}`);
if (publicBase) {
  const out = (await remote(`curl -sk -m 10 ${publicBase}/health || echo FAIL`)).trim();
  say(`经 nginx 探活 ${out}`);
}

say('');
say('各机器的 ~/.miraquota/sync.json 改成：');
say(JSON.stringify({ hub: publicBase ?? `http://127.0.0.1:${PORT}`, token: TOKEN, intervalSec: 600 }, null, 2));
say('');
say(`token 只打印这一次；之后去 ${HOST}:${DATA}/config.json 看。`);
say(`日志：ssh ${HOST} journalctl -u ${SERVICE} -f`);
