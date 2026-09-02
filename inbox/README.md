# 账本收件口（Cloudflare Worker）

共用额度的人**没有 GitHub** 时，靠这个收件口上传账本（2026-09-02 用户拍板）。
仓库令牌只放在 Worker 里；客户端只带「名字 + 自设口令 + 一次性邀请码」，都只在首次输入。
加人、换令牌都不动客户端。设计与身份模型见 `worker.mjs` 头注，原理见 `docs/MULTI-MACHINE.md`。

## 一次性部署（额度主人做，约 10 分钟）

前提：一个 Cloudflare 账号（免费档够用）。以下命令都在 `inbox/` 目录下跑。

1. 登录 Cloudflare：
   ```
   npx wrangler login
   ```
2. 建 KV（存账号口令哈希），把输出的 `id` 填进 `wrangler.toml` 的 `REPLACE_WITH_KV_ID`：
   ```
   npx wrangler kv namespace create ACCOUNTS
   ```
3. 在 GitHub 建一个**细粒度**令牌：只选 `miraquota-ledger` 这一个仓，权限只给 *Contents: Read and write*。
   有效期按 GitHub 允许的最长选；到期前 Worker 会开始报 401，重做这一步即可。
4. 存两个秘密：
   ```
   npx wrangler secret put GH_TOKEN       # 粘上一步的令牌
   npx wrangler secret put INVITE_CODE    # 自己定一个邀请码，口头告诉圈里人
   ```
5. 部署，记下输出的 `https://miraquota-inbox.<你的子域>.workers.dev`：
   ```
   npx wrangler deploy
   ```
6. 把这个地址填到 `provider/lib/ledger-sync.mjs` 的 `DEFAULT_INBOX`，发一版应用。
   （不填也能用——多机页登录框里可以手输地址。）

验证：浏览器打开 `<地址>/health` 应返回 `{"ok":true,...}`。

## 别人怎么加入

- **装了 MiraQuota 的人**：多机页 →「加入多机统计」→ 名字、口令、邀请码 → 登录并开始上传。
- **不装软件的人**：浏览器打开 `<地址>/lite.bat` 下载，双击，按提示输三样东西。
  它会建一个每 10 分钟跑一次的计划任务（`MiraQuotaLite`），只上传每次调用的时间、模型、token 数。
  停掉：`powershell -File %USERPROFILE%\.miraquota\lite.ps1 -Uninstall`。

同一个人的第二台机器只要名字 + 口令，不再要邀请码。名字全局唯一：已被占用且口令不对 ⇒ 换名字。

## 撤销与轮换

- 踢掉一个人：`npx wrangler kv key delete --binding ACCOUNTS "acct:<名字>"`，他下一次上传就 401。
- 换邀请码：重跑 `secret put INVITE_CODE`，已注册的人不受影响。
- 换仓库令牌：重跑 `secret put GH_TOKEN`，客户端无感。

## 它保证什么、不保证什么

- 保证：只有知道口令的人能以那个名字上传；名字只能注册一次；分片格式与大小受校验；
  同一机器 45 秒内只收一次；仓库令牌不出 Worker。
- 不保证：名字是真的——fxc 说自己是 fxc，Worker 只能记住「以后只有这个口令能用 fxc」。
  朋友圈里够用；要防人，只有 GitHub 登录那条路。
