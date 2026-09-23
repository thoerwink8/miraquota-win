# 账本存储约定（SQLite 流水账）

这一页是**机制约定**，不是使用说明：以后往库里加东西、改保留策略、换机器，都按这里的规矩来。
背景与实测数字见 [QUOTA-ESTIMATION.md](QUOTA-ESTIMATION.md)；多机同步见 [MULTI-MACHINE.md](MULTI-MACHINE.md)。

## 一句话

**流水（逐笔调用）是唯一真相，所有聚合都是视图或派生表。** 换口径、改报表、补维度都不许动流水本身。

这条规矩是从两次事故里长出来的：

| 事故 | 根因 | 现在的做法 |
|---|---|---|
| 2026-09-22 换美元口径（transcript ↔ 网关），被迫清空 8 天账本重扫 | 把"分钟聚合桶"当账本存，口径被烧进数据里 | 两份来源都进 `calls`，口径是 `effective` **视图**，换口径 = 换一行 DDL |
| 2026-09-23 本机 transcript 被 Claude Code 清理清空，账本从 ~$2500 掉到 $341 | 美元只认一个来源，另一个来源只用来报警 | 两份都留（`side` 标记），`max` 口径按「机器 × 模型 × 小时」取较大的那一边 |

## 库长什么样

一个文件：`~/.miraquota/store.db`（`STORE_FILE`）。WAL 模式，`synchronous=NORMAL`。

| 表 | 是什么 | 保留 |
|---|---|---|
| `calls` | **流水**：一次调用一行。`kh`=账目键哈希（唯一索引，去重身份）、`src`/`side`=来源、`ts/hour/day`、`sess`/`model`/`machine`/`effort`/`ws`（都是 `dims` 的整数 id）、`i/o/cr/cw` token、`usd`、`priced`、`billable` | 30 天（可配） |
| `daily` | 明细的日汇总，**永久**。明细删掉后报表照出 | 永久 |
| `dims` | 维度字典（`session`/`model`/`machine`/`effort`/`ws`）：字符串只存一次 | 永久 |
| `turns` | Mirasim 会话轮次：`task` + `sid` + 时间区间，**只用于任务归属**，不当花费来源 | 与 `calls` 同窗 |
| `points` | 官方点数采样（30 秒一采） | 90 天 |
| `marks` | 同一 tick 上各模型的**累计**美元（倍率标定） | 90 天 |
| `prices` / `families` | 价目与家族，开库时由代码常量种入（代码仍是唯一来源） | 覆盖式 |
| `machines` / `limits` | hub 侧：各机分片与账号额度快照 | 按分片 TTL |
| `meta` | `basis` 等元信息 | — |

### `effective` 视图 = 口径

```sql
-- max（默认）：每个 (machine, model, hour) 里两边的合计比大小，只留大的那一边的全部行
-- t / g / union：只认 transcript / 只认网关 / 两边相加（旧账本的做法）
```

`UsageStore.basis = 't' | 'g' | 'union' | 'max'` 换口径只执行一次 `DROP VIEW` + `CREATE VIEW`。
**实测**（同一份库，一个字节都没动）：`max $1988 / t $34 / g $1986 / union $2019`。

读法：账号点数是账号级的、本机账本只含本机花费，所以 `点数 ÷ 本机美元` 在他机也在花时**偏高**；
比值低于 100 才是"本机账本虚高"（重复计或价目填错）的信号。

## 磁盘与保留（实测，不是估的）

2026-09-23 在本机 24,251 行真实数据上量的：

| 版本 | 字节/行 | 24k 行合计 |
|---|---|---|
| 第一版（WITHOUT ROWID + 5 个二级索引 + 键原文） | 945 | 21.8 MB |
| 现在（rowid + 整数维度 + 键哈希 + 3 个索引） | **155** | **3.75 MB** |

省下来的地方：二级索引项不再嵌 75 字符的账目键（改嵌 8 字节 rowid）；会话 uuid/工作区路径/模型名
只存一次；日期用 `YYYYMMDD` 整数；**账目键原文不进库**（要回溯某笔调用，按
`(机器, 会话, 时刻, 模型)` 去原始记录里找——这个四元组是唯一的）。

按实测外推（本机 ~860 行/天，VPS ~2400 行/天）：

| 明细保留 | 本机 | VPS |
|---|---|---|
| 30 天（默认） | ~4 MB | ~11 MB |
| 90 天 | ~12 MB | ~33 MB |

两个旋钮：`DETAIL_DAYS`（默认 30）与 `node scripts/store-migrate.mjs --rollup --keep-days N`。
**明细删之前一定先汇进 `daily`**（`prune()` 内部就是这个顺序；反了就是永久丢数，契约测试盯着）。

## 任务粒度：会话是主键维度，任务是归属视图

- **会话（`sid`）逐笔都有**，是流水的主维度，报表全覆盖；
- **任务（Mirasim 的 `taskId`）按时间区间归属**：`turns` 表给 `[startedAt, updatedAt]`，
  调用的 `ts` 落在这个区间里就归那个任务；
- **归不上的部分必须单独列出来**（`byTask().unclaimed`）。轮次只覆盖 Mirasim 管起来的会话
  （实测 1201 轮里 1068 轮有 taskId），把它摊到别的任务头上就是编数；
- 轮次里的 `usage` **不当作花费来源**：它没有缓存写，而缓存读/写占 fable 花费一半以上，
  当来源会与 transcript 重复计。

## 还有哪些数据该进库（2026-09-23 全量审计）

| 数据 | 现在 | 结论 |
|---|---|---|
| 账本 `ledger.json` | 8 天 443 KB–2.2 MB（其中去重键 75–85%） | **进库**（`calls` + 视图） |
| 标定 `calibration.json` | 141 KB，3 天 | **进库**（`points` + `marks`）；mark 由增量改存累计，`broken` 标基准断点 |
| 锚点 `anchor.json` | 小 | 进库（`machines`/`limits` 同族），Phase 2 |
| 点数归因 `points-attrib.json` | 74 KB | 进库（一张 `attrib` 表），Phase 2 |
| hub 分片目录 `shards/*.json` + `limits.json` | N 个小文件 | 进库（一台机一行），省 inode 与 rename |
| 价目缓存 `~/.mirasim/models-dev-cache.json` | 只读输入 | 只把**用到的那几列**种进 `prices`（代码里的 `BUILTIN` 是种子）；原始缓存不动 |
| `settings.json` / `sync.json` / `install.json` / `ui.json` / `inbox-admin.json` / `feed.token` | 配置与密钥 | **留 JSON**：人要能手改、密钥不该进库、坏了要能一眼看懂 |
| `sync-repo/`（git 通道） | 目录 | **删掉**（见下） |

## 收件口（Cloudflare Worker）不需要 SQLite

Worker 上没有文件系统，硬塞 SQL 只有 D1 一条路，而这里要的只是"把流水存下来"：

- Worker 继续用 **KV**，但**按同一套行格式存流水块**（一台机器一天一个 key，NDJSON）；
- 查询一律在**读的一侧**做（本机或 hub 的 SQLite）——`inbox/shared.mjs` 的 `#materialize`
  已经在做同一件事（原始行在读取端定价），流水块照这个模式走；
- 好处：全链路只有**一种行格式、一个查询引擎**，Worker 保持成一个哑存储。

## 迁机器（"月底迁 VPS"复用同一条路）

三条命令，都是同一套代码：

```bash
node scripts/store-migrate.mjs --import                    # ① 扫原始记录重建（旧数据迁移、换盘、换机器）
node scripts/store-migrate.mjs --pack /tmp/store.db        # ② 出一份一致的单文件快照（VACUUM INTO）
node scripts/store-migrate.mjs --inspect /tmp/store.db     # ③ 校验快照（schema 版本 + integrity + 行数 + 跨度）
```

- **必须用 `--pack`，不能直接 `cp store.db`**：WAL 模式下新数据在 `-wal` 里，拷主文件会漏。
  实测顺带把碎片压掉：21.8 MB → 5.4 MB。
- 原始记录（transcript / 网关 / 会话库）**一起带过去**再 `--import` 是最稳的：它顺带验证了
  读原始记录这条路没坏。
- 快照的 `user_version` 比程序新时**拒绝打开**（`UsageStore` 构造时抛错），不猜、不降级读。

## 传输：只留 hub

`git 通道`（把分片提交进一个私有 GitHub 仓）要退役，理由是可量化的：

- 每个分片 333 KB（实测），每 10 分钟一推 → **47 MB/天/机**的提交量，而它换来的只是"不用自建服务器"；
- 它还要 `gh` 凭据（本机 `gh` 登录态失效时整条路就断了）；
- 流水明细比聚合分片大得多，走 git 只会更糟。

保留两条：**hub（HTTP，主力）** 与 **收件口（没有服务器的场景）**。hub 加一个 `PUT /journal`
收流水增量（Phase 2），此后 hub 手里就是全账号的流水，任务级报表与逐点对账都在它上面出。

## 契约（改动时按这张表自查）

1. **流水是唯一真相**：任何新报表都从 `calls`/`effective` 算，不许另存一份聚合当账本；
2. **口径是视图**：加口径 = 加一个 `viewSql` 分支 + `BASES` 一行，不许改 `calls` 的语义；
3. **去重靠 `kh` 主键**，重读同一个文件必须幂等；同一账目键取较大值；
4. **保留先汇总后删**，`prune()` 是唯一入口；`daily` 永久；
5. **不丢记录**：没价的（`priced=0`）与没走 relay 的（`billable=0`）都留在流水里，
   只在算钱时排除——旧账本在解析时就丢掉整条，那些调用在任何报表里都不存在；
6. **schema 版本只升不降**：`STORE_SCHEMA` 提升时，旧库要么能就地迁移，要么明确拒绝打开；
7. **一条写入路径**：`sources.mjs` 读原始记录 → `insertCalls` 写库；迁移、实时采集、
   hub 汇总都用它，不许有第二份导入逻辑；
8. **测试盯住上面每一条**（`test/store.test.mjs`，11 条契约）。

## 还没做的（Phase 2/3）

- Phase 2：`Engine` 改用 `UsageStore`（payload 形状不变，界面零改动）；hub 加 `PUT /journal`；
  `calibration`/`points-attrib`/`anchors` 收进库。
- Phase 3：删 git 通道与 `gh` 依赖；收件口按流水块收发；任务/工作区报表进界面。
