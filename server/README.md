# MiraQuota Hub：账本与账号额度的唯一真相

一台各机都连得上的服务器，收下每台机器推来的账本分片与账号额度，合并、算好整份 payload。
面板填一个地址就能看，不区分机器。

## 为什么有它

从前每台机器各自把分片推进私有 git 仓 / Cloudflare Worker，再各自拉回来自己合并、
自己标定、自己算口径。三个后果：

1. **口径每台算一遍** —— 版本一错就是两个数；
2. **实时性卡在 git 节流上**（10 分钟）；
3. **新机器要 GitHub 凭据或邀请码**才进得来。

hub 之后：机器只管把自己那份推上来，服务器算好，面板拿现成的画。

## 它刻意不做的事

- **不读任何本机会话记录**。那台机器上没有别人的 transcript，账本全部来自推上来的分片
  （`Engine` 的 `noLocal`）。
- **不自己读 `/v1/limits`**。服务器上没有 Mirasim，账号额度由跑着 Mirasim 的机器 PUT 上来，
  经 `Engine.ingestLimits()` 进**同一条路** —— 服务端不长第二套口径。
- **不认 IP 当身份**。IP 会变（拨号、切网、代理），认它会把一台机器认成五台。
  身份一律 `installId`，IP 只作「从哪连的」显示。
- **不上数据库**。存的东西总量小、永远整份覆盖、丢了各机下一轮就重推 —— JSON 文件正好，
  省掉一个要备份、要升级、会挂的组件。

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 无 | 探活 |
| PUT | `/shard` | 写 token | 推一台机器的分片（v1 聚合态 / v2 原始行都收） |
| PUT | `/limits` | 写 token | 推账号额度快照（跑着 Mirasim 的机器才有） |
| GET | `/payload` | 读 token（默认不开） | 算好的 quota.json，与本机 provider 逐字段同构 |
| GET | `/stream` | 读 token | SSE：payload 变了就推，秒级 |
| GET | `/shards` | 读 token | 在架分片原样返回（排查用） |

`PUT /limits` 只留最新一份：账号额度是账号级的，谁读到都是同一份，存多份只会带来
「该信谁」这个本来不存在的问题。**收到的比在架的旧就不收**（慢包后到、机器时钟不齐）。

## 部署

```
node scripts/deploy-hub.mjs --host <ssh 别名>
```

幂等，可重复跑。它做五件事：探条件、送 `server/` + `provider/` + `inbox/shared.mjs`、
生成一次性 token、装 systemd 服务 `miraquota-hub`、在现有 nginx 里挂一个 `/mq/` 反代。

两条硬边界（都是实咬出来的）：

- **不动系统 node**。那台机器上的 node 多半是给别的服务用的；升级它去伺候一个监控面板，
  代价是把人家的网关一起赌上。要 node 22 就单装一份官方 tarball 到 `/opt/node22`，
  systemd 单元直接指它，系统 PATH 一个字节不改。
- **nginx 的备份与中间文件不能落在 `sites-enabled/` 里**。nginx include 的是
  `sites-enabled/*`，放那儿会立刻变成第二份生效配置（实咬：`duplicate default server
  for 0.0.0.0:443`）。备份去 `/var/backups/nginx-miraquota/`，改完先 `nginx -t`，
  不过就把原文件放回去再退出 —— 配置留在坏状态，下一次任何人 reload 都会连累别的服务。

拆掉：`node scripts/deploy-hub.mjs --host <别名> --uninstall`（数据目录保留）。

## 客户端怎么接

`~/.miraquota/sync.json`：

```json
{ "hub": "https://<地址>/mq", "token": "<装的时候打印的>", "intervalSec": 600 }
```

配了 `hub` 就走 hub，不再碰 git 仓与收件口 —— 那两条是「没有服务器时的替代品」。
`quotaIntervalSec`（默认 `min(intervalSec, 120)`）管账号额度那几轮的快节奏，
详见 `docs/MULTI-MACHINE.md`。
