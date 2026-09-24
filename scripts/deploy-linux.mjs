#!/usr/bin/env node
/**
 * 把 MiraQuota 的账本上报装到一台 Linux 机器上（一条命令，可重复跑）。
 *
 *   node scripts/deploy-linux.mjs --host contabo-jump [--account fxc-server]
 *
 * 那台机器没有界面、也不需要有：它跑 `provider --sync-only`，只做一件事——
 * 把本机账本与速度快照发成分片，让有界面的机器在多机页看得见「谁花的、跑什么模型、多快」。
 *
 * 为什么走收件口而不是 git 通道：服务器上没有那个私有账本仓的 GitHub 凭据，
 * 而收件口只要「名字 + 口令 + 一次性邀请码」（见 inbox/README.md）。口令是脚本随机生成的，
 * 落在那台机器的 ~/.miraquota/sync.json 里，本机不留副本——要用时去那台机器看。
 *
 * 幂等：重复跑只更新代码并重启服务；已有的 sync.json 一律不动（不会把机器改名、换口令——
 * 要换得显式给 --reset-sync）。账号额度不归这台机器管：它由 fleet-dao 统一读。
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_FILE = join(homedir(), '.miraquota', 'inbox-admin.json');
const SERVICE = 'miraquota-sync';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

if (flag('help') || !opt('host')) {
  console.log(`用法 node scripts/deploy-linux.mjs --host <ssh 别名或 user@ip> [选项]

  --host <目标>       必填。要能免密 ssh 上去（~/.ssh/config 里的别名最省事）
  --dir <路径>        代码落点，默认 /opt/miraquota
  --via-inbox         走收件口通道：--account <名字> / --invite <码> / --inbox <地址>
  --reset-sync        已有 sync.json 时也覆盖。默认**不动**它——盖掉会把那台机器从现有面板上踢下来
  --uninstall         停掉并删除那台机器上的服务与代码（sync.json 保留）

不带通道参数时：已有 sync.json 就原样保留；没有的话只装服务并提示（不猜）。
收件口通道要求**看面板的那台机器**能连上 workers.dev，国内直连不通（见 docs/MULTI-MACHINE.md）。
hub 通道 2026-09-24 下线：还配着 hub 的机器用 --reset-sync --via-inbox 换过来。`);
  process.exit(opt('host') ? 0 : 1);
}

const HOST = opt('host');
const DIR = opt('dir', '/opt/miraquota');
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=25'];
const say = (m) => console.log(m);

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
$S rm -rf ${DIR}`);
  say(`已删除 ${HOST} 上的服务与代码；~/.miraquota/sync.json 保留（要彻底退出多机统计就删掉它）`);
  process.exit(0);
}

/* ---------------- 1. 那台机器够不够条件 ---------------- */
const probe = await remote(`
node -v 2>/dev/null || echo NO_NODE
hostname
[ -d "$HOME/.mirasim/insights" ] && echo HAS_INSIGHTS || echo NO_INSIGHTS
[ -f "$HOME/.miraquota/sync.json" ] && echo HAS_SYNC || echo NO_SYNC
`);
const lines = probe.trim().split(/\r?\n/).map((s) => s.trim());
const nodeVer = lines[0];
if (nodeVer === 'NO_NODE') {
  console.error(`${HOST} 上没有 node。装 22 以上再来（provider 用了全局 fetch/WebSocket）`);
  process.exit(1);
}
const major = Number(/v(\d+)/.exec(nodeVer)?.[1] ?? 0);
if (major < 22) { console.error(`${HOST} 的 node 是 ${nodeVer}，需要 22 以上`); process.exit(1); }
const hostShort = (lines[1] ?? 'server').split('.')[0];
if (lines.includes('NO_INSIGHTS')) {
  say(`注意：${HOST} 上没有 ~/.mirasim/insights——那台机器没有网关账本，分片会是空的。`);
  say('（只有 Mirasim / relay 在那台机器上跑过，才有可上报的用量。）');
}
const hasSync = lines.includes('HAS_SYNC');
say(`${HOST} · ${hostShort} · node ${nodeVer} · 同步配置 ${hasSync ? '已有（不动）' : '待写入'}`);

/* ---------------- 2. 送代码：provider + 迁移工具，纯 Node、零依赖 ---------------- */
await remote(`mkdir -p ${DIR}`);
await new Promise((resolve, reject) => {
  // store-migrate.mjs 一起送：那台机器要能自己重建账本（换盘、换机器、迁 VPS 都走它），
  // 它读原始记录用的是同一套 provider/lib/sources.mjs。
  const tar = spawn('tar', ['-cf', '-', 'provider', 'scripts/store-migrate.mjs'], { cwd: ROOT, windowsHide: true });
  const ssh = spawn('ssh', [...SSH, HOST, `tar -xf - -C ${DIR}`], { windowsHide: true });
  let err = '';
  tar.stderr.on('data', (d) => { err += d; });
  ssh.stderr.on('data', (d) => { err += d; });
  tar.stdout.pipe(ssh.stdin);
  ssh.on('error', reject);
  ssh.on('close', (code) => code === 0 ? resolve() : reject(new Error(`传代码失败（${code}）：${err.trim()}`)));
});
say(`代码已同步到 ${HOST}:${DIR}/provider`);

/* ---------------- 3. 同步通道 ----------------
 * 优先级：已有 sync.json 不动 → --via-inbox。没有通道参数时只装服务并提示。
 * 退役的两条：git 通道 2026-09-23（用户：「不要存 Github，占项目大小和烧 cpu」——实测每台机器
 * 每 10 分钟要提交 333 KB ≈ 47 MB/天）；hub 通道 2026-09-24（多机额度改由 fleet-dao 统一读）。
 * --reset-sync 必须能把已有配置换掉：从前 via-inbox 还挂着 `!hasSync`，于是
 * `--reset-sync --via-inbox` 落到「未配置」那条、什么都没换——从 hub 换过来的机器正要走这条。
 */
const keepSync = hasSync && !flag('reset-sync');

if (keepSync) {
  say(`同步配置已有（保持不动）：${HOST}:~/.miraquota/sync.json。要换通道加 --reset-sync --via-inbox`);
} else if (flag('via-inbox')) {
  let admin = {};
  try { admin = JSON.parse(readFileSync(ADMIN_FILE, 'utf8')); } catch { /* 下面统一报错 */ }
  const inbox = opt('inbox', admin.inbox);
  const invite = opt('invite', admin.invite);
  if (!inbox || !invite) {
    console.error(`缺收件口地址或邀请码：${ADMIN_FILE} 读不到，命令行也没给 --inbox / --invite`);
    process.exit(1);
  }
  const account = (opt('account') ?? `${hostShort}-server`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 24);
  const passphrase = randomBytes(12).toString('hex');
  // 注册在那台机器上做：收件口在 workers.dev，国内直连被 DNS 投毒（见 docs/MULTI-MACHINE.md），
  // 而服务器在墙外反而直通。口令因此也只落在它自己盘上。
  const out = await remote(`set -e
mkdir -p "$HOME/.miraquota"
export INBOX='${inbox}' ACCOUNT='${account}' PASS='${passphrase}' INVITE='${invite}'
node --input-type=module -e '
import { writeFileSync } from "node:fs";
const base = process.env.INBOX.replace(/\\/+$/, "");
const post = async (path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const e = new Error((await r.text()).slice(0, 200)); e.status = r.status; throw e; }
};
const acct = { account: process.env.ACCOUNT, passphrase: process.env.PASS };
let how = "LOGIN";
try { await post("/login", acct); } catch (e) {
  if (e.status !== 401) { console.error(e.message); process.exit(1); }
  await post("/register", { ...acct, invite: process.env.INVITE });
  how = "REGISTER";
}
writeFileSync(process.env.HOME + "/.miraquota/sync.json",
  JSON.stringify({ inbox: base, account: acct.account, passphrase: acct.passphrase, intervalSec: 600 }, null, 2) + "\\n");
console.log(how);
'`);
  say(`收件口${out.includes('REGISTER') ? '已注册' : '已登录'}：${account} · 口令在 ${HOST}:~/.miraquota/sync.json`);
} else {
  // 没给通道参数：只装服务，不猜也不去 GitHub 装密钥。
  say(hasSync
    ? `--reset-sync 要配 --via-inbox 才知道换成什么；${HOST}:~/.miraquota/sync.json 没动。`
    : `同步通道未配置：${HOST} 上还没有 ~/.miraquota/sync.json。`);
  say(`  用收件口：node scripts/deploy-linux.mjs --host ${HOST} --via-inbox（需要看面板的机器能连 workers.dev）`);
  say('  服务照常起来，只是不上报；补上 sync.json 后下一轮就会开始发。');
}


/* ---------------- 4. systemd 常驻 ---------------- */
const unit = await remote(`set -e
S=$([ "$(id -u)" = 0 ] || echo sudo)
NODE=$(command -v node)
$S tee /etc/systemd/system/${SERVICE}.service >/dev/null <<UNIT
[Unit]
Description=MiraQuota ledger sync (headless: publishes this machine usage + speed shard)
After=network-online.target

[Service]
Type=simple
ExecStart=$NODE ${DIR}/provider/miraquota-provider.mjs --sync-only
Restart=always
RestartSec=30
Nice=10

[Install]
WantedBy=multi-user.target
UNIT
$S systemctl daemon-reload
$S systemctl enable --now ${SERVICE} 2>&1 | grep -v '^Created symlink' || true
$S systemctl restart ${SERVICE}
sleep 10
$S systemctl is-active ${SERVICE}
$S journalctl -u ${SERVICE} -n 4 --no-pager -o cat`);
say(`服务 ${SERVICE}：`);
say(unit.trim().split('\n').map((l) => '  ' + l).join('\n'));
say('');
say(`跟日志：ssh ${HOST} journalctl -u ${SERVICE} -f`);
say('本机面板的「多机」页下一轮（最多 10 分钟）就会多出这台机器；速度卡顶部可切到它。');