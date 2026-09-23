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
| `hourly` | 明细的小时汇总，**永久**。明细删掉后报表照出，且与明细层**逐字同一个口径** | 永久 |
| `dims` | 维度字典（`session`/`model`/`machine`/`effort`/`ws`）：字符串只存一次 | 永久 |
| `turns` | Mirasim 会话轮次：`task` + `sid` + 时间区间，**只用于任务归属**，不当花费来源 | 与 `calls` 同窗 |
| `points` | 官方点数采样（30 秒一采） | 90 天 |
| `marks` | 同一 tick 上各模型的**累计**美元（倍率标定）；`broken=1` 标基准断点 | 90 天 |
| `prices` / `families` | 价目与家族，开库时由代码常量种入（代码仍是唯一来源） | 覆盖式 |
| `machines` / `limits` | hub 侧：各机分片与账号额度快照 | 按分片 TTL |
| `meta` | `basis` 等元信息 | — |

**汇总层为什么按小时而不是按天**：口径是「逐小时逐模型取大」，汇总层若按天存，历史区间就只能
按天取大，而 `Σ_h max(T_h,G_h) ≥ max(Σ_h T_h, Σ_h G_h)`——**恒偏低**。实测 VPS 上差 $6.87
（0.15%）。对账工具不该带偏差，所以汇总层按小时存（行数多几倍，90 天约 1 MB），
`totalWithDaily()` 于是与 `effective` 视图逐字一致。实测两台机器都**分文不差**：

```
本机  $5899.08 = 明细 $1780.14 + 汇总 $4118.94
VPS   $4667.76 = 明细 $23.64   + 汇总 $4644.12
```

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
**明细删之前一定先汇进 `hourly`**（`prune()` 内部就是这个顺序；反了就是永久丢数，契约测试盯着）。
汇总层按小时存（理由见上），行数比按天多几倍但总额分文不差。

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
4. **保留先汇总后删**，`prune()` 是唯一入口；`hourly` 永久；
5. **不丢记录**：没价的（`priced=0`）与没走 relay 的（`billable=0`）都留在流水里，
   只在算钱时排除——旧账本在解析时就丢掉整条，那些调用在任何报表里都不存在；
6. **schema 版本只升不降**：改 `calls`/`hourly`/`dims` 的列或主键就必须 `STORE_SCHEMA + 1`；
   `user_version` 比程序新时**拒绝打开**（构造时抛错），不猜、不降级读；
   旧版本库目前走「重建派生表」（`dims`/`calls`/`hourly` 能从原始记录重扫回来）——**这只对
   v1–v3 成立**（都没发布过）。从 v3 起，破坏性改形状必须先写就地迁移：流水一旦成了唯一副本
   （原始记录被清理），重建就等于丢账；
7. **一条写入路径**：`sources.mjs` 读原始记录 → `insertCalls` 写库；迁移、实时采集、
   hub 汇总都用它，不许有第二份导入逻辑；
8. **测试盯住上面每一条**：`test/store.test.mjs`（11 条库的契约）+ `test/store-cli.test.mjs`
   （2 条整条迁移路径的契约：导入→对账→任务→保留→打包，幂等与总额守恒都在里面）。

## 迁移进度

- ✅ **Phase 1**：`store.mjs` / `sources.mjs` / 迁移工具 / 本机与 VPS 全流程导入 / 契约测试。
- ✅ **Phase 2a**：`Engine` 已改用 `JournalLedger`（= SQLite 流水账 + 旧账本那套接口）。
  payload 形状没变、界面零改动。`ledger.json` 从此只是历史文件（不再读写，留着回滚与人工比对）。
- ✅ **Phase 2b**：标定（`points`/`marks`）进库。`Calibrator` 落盘换成 SQLite 的 `points`/`marks`
  两张表，`calibration.json` 只在**库里一条都没有**时读一次当迁移源，此后不再写。内存形状不变，
  所以倍率那条链一个字节没动（库里存累计、估算器要增量，读回来换算一次）。
  ⏳ 还差**点数归因**（`points-attrib.json` 74 KB → `attrib` 表）与**锚点**（`anchor.json`）。
- ✅ **Phase 2c**：hub 收流水明细（`PUT /journal`）。客户端按批推、推完才退水位（水位存 `meta`，
  重启不丢）；行的 `kh` 是主键，重推幂等。**分片与明细盖住同一分钟时只算一次**（按
  (机器, 分钟) 逐格让位）——实测 VPS 两样都推之后，账号 7 天合计从 $120.07 虚高到 $121.88。
- ✅ **Phase 3c**：任务/工作区/会话报表进界面（payload 的 `ledger` 块 + 口径页一张卡）。
  真机一帧：近 7 天 $1733.05，能归到任务的 $1484.99（86%），归不上的 $248.07 单列不摊派。
- ⏳ **Phase 3（余下）**：删 git 通道与 `gh` 依赖（实测 333 KB/10 分钟 = 47 MB/天/机的提交量）——
  已退出所有默认路径（要 `--via-git` 显式），代码与那十来条多机测试还在；
  收件口（Cloudflare KV）按同一套行格式收流水块；**Phase 2b 余下的归因与锚点**。

### 2026-09-23 上线时实咬的三处（都已修 + 都有测试）

1. **轮询重入 + 全量重读**：`refresh()` 每轮重读网关 1.7 MB/天 + 会话 166 文件 30 MB，且
   `setInterval` + `poll()` 可重入 → 应用窗口「未响应」，主进程烧 137 秒 CPU。
   游标 + `#pollBusy` 之后每轮 363 ms → **14 ms**。
2. **`spent()` 从内存前缀和换成 SQL**：`Calibrator.estimate()` 每帧问 657 次 → 一帧 payload
   **20.7 秒**。把索引搭回旧账本的形状（内存前缀和，写入作废）之后四窗标定 **3 ms**。
   *接口兼容不等于性能兼容*。
3. **`setReadBigInts` 是整条语句级别的**：`kh` 是 63 位整数必须这么读，但 `ts`/`i`/`o` 也跟着
   变 BigInt，`JSON.stringify` 直接抛——流水一条都推不上去。补了一条专盯 `journalSince` 的测试
   （hub 那条是直接 POST 行的，绕过了这个函数，所以没拦住）。

