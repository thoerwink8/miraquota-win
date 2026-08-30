# 模型家族计费切换实施计划

> **面向执行者：** 按测试驱动顺序逐项实施并在每个阶段运行 `pnpm test`。

**目标：** 在保留现有额度与页面结构的前提下，增加动态云端模型家族计费切换，并让速度区展示最近 5 种具体模型及各自最近 5 个任务。

**架构：** 新增纯函数模块统一模型家族归类和云端账本判定。账本为真实 relay 请求建立家族分钟桶，数据引擎把动态家族列表、当前选择和各窗口家族支出加入 `quota.json`。速度模块继续接收所有来源样本，但将输出限制为最近 5 种具体模型，并附带每种模型最近 5 个任务。

**技术栈：** Node.js ES modules、Electron IPC、原生 HTML/CSS/JavaScript、`node:test`。

---

## 实施步骤

- [ ] 新增 `provider/lib/model-families.mjs`，实现 Claude/Fable、GPT 等模型家族归并、云端请求过滤和最近模型任务汇总。
- [ ] 扩展 `provider/lib/ledger.mjs`，保存真实云端请求的家族分钟桶和最近使用时间。
- [ ] 扩展 `provider/lib/engine.mjs`，输出 `billingFamilies`、`billingFamily` 与每个窗口的 `familySpentUSD`。
- [ ] 扩展 `provider/lib/speed.mjs`，输出最近 5 种具体模型及每种模型最近 5 个任务。
- [ ] 在 `app/main.mjs` 与 `app/preload.cjs` 中增加选择保存和 IPC。
- [ ] 在 `app/renderer/index.html` 顶部 `$ / 点` 左侧增加动态家族选择，并让速度模型行支持任务展开。
- [ ] 同步 `widget/miraquota-widget.js` 的当前计费徽标和任务展开。
- [ ] 运行 `pnpm test`、语法检查、界面检查和 `pnpm dist`。
