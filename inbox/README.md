# 账本收件口（Cloudflare Worker）

共用额度的人**没有 GitHub** 时，靠这个收件口上传账本（2026-09-02 用户拍板）。
分片直接存 Worker 的 KV，不写 GitHub 仓——所以 Worker **不需要任何 GitHub 令牌**，
唯一的秘密是邀请码。客户端只带「名字 + 自设口令 + 一次性邀请码」，都只在首次输入。
设计与身份模型见 `worker.mjs` 头注，原理见 `docs/MULTI-MACHINE.md`。

## 部署（额度主人做一次）

人只需要做一步：

```
cd inbox && npx wrangler login      # 浏览器弹出 Cloudflare 授权页，点「Allow」
```

剩下的一条命令全包（建 KV、存邀请码、部署、把地址写进应用默认值）：

```
node scripts/inbox-deploy.mjs --invite <你定的邀请码>
```

然后提交、发版。验证：浏览器打开 `<地址>/health` 应返回 `{"ok":true,"store":"kv"}`。

## 别人怎么加入

- **装了 MiraQuota 的人**：多机页 →「加入多机统计」→ 名字、口令、邀请码 → 登录并开始上传。
- **不装软件的人**：浏览器打开 `<地址>/lite.bat` 下载，双击，按提示输三样东西。
  它会建一个每 10 分钟跑一次的计划任务（`MiraQuotaLite`），只上传每次调用的时间、模型、token 数。
  停掉：`powershell -File %USERPROFILE%\.miraquota\lite.ps1 -Uninstall`。

同一个人的第二台机器只要名字 + 口令，不再要邀请码。名字全局唯一：已被占用且口令不对 ⇒ 换名字。

## 撤销与轮换

- 踢掉一个人：`npx wrangler kv key delete --binding ACCOUNTS "acct:<名字>"`，他下一次上传就 401；
  他的分片键 `shard:<名字>--…` 两周不更新自动过期，要立刻消失就一并删。
- 换邀请码：`node scripts/inbox-deploy.mjs --invite <新码>`，已注册的人不受影响。

## 它保证什么、不保证什么

- 保证：只有知道口令的人能以那个名字上传；名字只能注册一次；分片格式与大小受校验；
  同一机器 45 秒内只收一次；两周不上传的机器自动消失。
- 不保证：名字是真的——fxc 说自己是 fxc，Worker 只能记住「以后只有这个口令能用 fxc」。
  朋友圈里够用；要防人，只有 GitHub 登录那条路。

## 网络

收件口在 `*.workers.dev`，国内实测 DNS 被投毒、直连不通（经代理可用），`api.cloudflare.com` 不受影响。
2026-09-03 用户拍板暂不绑自有域名。要过墙：把一个域名托管到 Cloudflare，在 Worker 设置里加
Custom Domain，然后 `node scripts/inbox-deploy.mjs` 会把新地址写回 `DEFAULT_INBOX`（代码不用改）。
