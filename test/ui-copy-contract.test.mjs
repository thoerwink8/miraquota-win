import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../widget/miraquota-widget.js', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../provider/lib/engine.mjs', import.meta.url), 'utf8');

test('new users start in the authoritative points mode', () => {
  assert.match(renderer, /let MODE = 'pts';/);
  assert.match(renderer, /<button id="modePts" class="on">点<\/button>/);
  assert.match(renderer, /<button id="modeUsd">\$<\/button>/);
});

test('account-level dollar values are visibly approximate in the embedded widget', () => {
  assert.match(widget, /primary\.scaledSpentUSD != null[\s\S]*?\n\s*\? '≈' \+ usd\(primary\.scaledSpentUSD\)/);
  assert.match(widget, /`余 ≈\$\{usd\(w\.remainingUSD\)\}`/);
});

test('each card shows exactly one full-quota number, and it no longer wears the ≈', () => {
  // 2026-09-02：满额改走官方「额度点 ÷ 100」后就是精确值，再挂 ≈ 是自贬。
  // 余 / 账号级已用同样由官方点数直接除得，一并脱掉推断标记。
  assert.ok(renderer.includes('<span class="tag">满额</span>'));
  assert.doesNotMatch(renderer, /满额≈/);
  assert.ok(widget.includes("'/ 满额 ' + usd(w.fullUSD)"));
  assert.doesNotMatch(widget, /满额≈/);
  // 旧的两口径字段整条链路都不该再有（payload 也不再产出它）
  for (const src of [renderer, widget, engine]) assert.doesNotMatch(src, /fullUSDOfficial/);
});

test('a today card answers daily usage that rolling windows cannot', () => {
  // 官方只有滚动窗，「今天用了多少」是用户明确要的参考值（2026-08-31）
  assert.match(renderer, /function todayCard\(t\)/);
  assert.match(renderer, /todayCard\(p\.today\)/);
  assert.match(renderer, /0:00 起/);
});

test('all model families show side by side instead of a picker', () => {
  // 家族选择器已删（用户 2026-08-31：应该都统计，不是选谁看谁）；卡片直接列全家族明细
  assert.doesNotMatch(renderer, /id="billingFamily"/);
  assert.doesNotMatch(renderer, /setBillingFamily/);
  assert.match(renderer, /function familyRow\(w\)/);
  assert.match(renderer, /w\.families/);
});

test('cards carry colored pace and exhaustion clock time, and no usage chart', () => {
  // 图表两版都试过（累计线读不懂、节奏柱太占地），用户 2026-08-31 拍板彻底删除：
  // 决策信息由省/快徽章 + 打满钟点 + 耗尽预演承担，卡片不再放走势图
  assert.doesNotMatch(renderer, /function sparkline|activityBars/);
  assert.match(renderer, /pace-fast/);
  assert.match(renderer, /pace-save/);
  assert.match(renderer, /打满/);
});

test('speed surfaces drop repeated billing badges and keep expandable recent tasks', () => {
  assert.doesNotMatch(renderer, /当前计费/);
  assert.doesNotMatch(widget, /当前计费/);
  // 「首 —」占位噪音不再出现在渲染串里，统一为「首字 ≈」或直接省略
  assert.doesNotMatch(renderer, /'首 —'|`首 —|首 — ·/);
  assert.doesNotMatch(widget, /'首 —'|`首 —|首 — ·/);
  assert.match(renderer, /首字 ≈/);
  assert.match(widget, /首字 /);
  assert.match(renderer, /r\.tasks/);
  assert.match(renderer, /openSpeedModels\.has\(r\.model\)/);
  assert.match(widget, /row\.tasks/);
  assert.match(widget, /r\.open = !r\.open/);
});

test('multi-machine detail lives in its own tab, never in the overview cards', () => {
  // 用户 2026-09-01：运维态信息不许占总览的额度位置，挪成独立页签
  assert.doesNotMatch(renderer, /id="syncCard"/);
  assert.match(renderer, /<button id="tabSync" style="display:none">多机<\/button>/);
  assert.match(renderer, /sync: \['tabSync', 'pageSync'\]/);
  // 未配置且没有登录入口时：页签不出现，且这一页不可被激活（记住的页签也挡回总览）。
  // 有登录入口（payload 带 syncLogin）时页签出现，但只给登录卡（2026-09-02 收件口）。
  assert.ok(renderer.includes("$('tabSync').style.display = (sy || canLogin) ? '' : 'none';"));
  assert.match(renderer, /name === 'sync' && !syncAvailable/);
  assert.ok(renderer.includes("if (!sy && !canLogin && $('pageSync').classList.contains('on')) switchTab('main');"));
  // 总览页脚只留一行摘要 + 去哪看
  assert.match(renderer, /多机 ×\$\{\(sy\.machines \?\? \[\]\)\.length\} · \$\{mark\} →/);
  assert.match(renderer, /e\.target\.closest\('#footSync'\)/);
  // 这一页要交代它在干什么：为什么合并、失败的后果、配置文件与周期
  assert.match(renderer, /为什么要合并/);
  assert.match(renderer, /<b>不会算错<\/b>/);
  assert.match(renderer, /分钟同步一轮/);
  assert.match(renderer, /~\/\.miraquota\/sync\.json/);
});

test('sync state copy keeps red for real trouble and shows the raw reason next to the plain one', () => {
  // 四态四色：绿=已接入、黄=中间态（本机已上传 / 抖动重试）、红=要处置、灰=连接中
  assert.match(renderer, /\.sync-state\.warn \{ color: var\(--warn\); \}/);
  assert.match(renderer, /`收件口已接入 · \$\{esc\(sy\.account \?\? ''\)\}`/);
  assert.doesNotMatch(renderer, /GitHub 已接入|GitHub 直连/, 'git 通道早退役了，别再拿它当状态名');
  assert.match(renderer, /'同步失败：' \+ esc\(sy\.errorHint \?\? sy\.error \?\? ''\)/);
  assert.match(renderer, /'本机已上传，读取他机失败' : '同步重试中'/);
  assert.match(renderer, /'连接中…'/);
  // 人话归纳是导读，原始报错仍作次要小字并存
  assert.match(renderer, /if \(sy\.error\) why\.push\(esc\(sy\.error\)\)/);
  assert.match(renderer, /已连续 \$\{sy\.failStreak\} 轮未成功/);
  // 机器明细每台一行：本机标注 +「N 分钟前推送」+ 过期判定（2×intervalSec）
  assert.match(renderer, /（本机）/);
  assert.match(renderer, /推送/);
  assert.match(renderer, /已过期/);
  assert.match(renderer, /2 \* \(sy\.intervalSec \?\? 600\)/);
  // widget 悬浮窗保持极简：状态色点 + ×N，不进机器明细
  assert.match(widget, /多机 ×/);
  assert.doesNotMatch(widget, /已过期/);
  assert.doesNotMatch(widget, /lastShardSec/);
});

test('速度卡每一行要带 5h 窗花费，且窗口口径只能有一个含义', () => {
  // 用户 2026-09-23：「速度那一栏，能不能顺便填写一下这一行本次消耗的费用，这样更直观」，
  // 随后追问「本轮到底是什么意思」——因为第一版把「当前 5h 窗口」和「最近 5 小时」两种含义
  // 塞进了同一个标签。钉住：只有当前官方 5h 窗口一种定义，读不到就**不给这个数**（不许换定义），
  // 标签写死窗口与口径（本机账本，不是官方点数换算——官方点数没有按模型的拆分）。
  assert.match(engine, /#speedWithCost\(this\.#speedReport\(\)/);
  assert.match(engine, /this\.ledger\.store\.byModel\(from, nowSec\)/);
  assert.match(engine, /usd\.get\(r\.modelId\)/);
  assert.match(engine, /if \(w\?\.resetAt == null \|\| !w\?\.durationSeconds\) return report;/);
  assert.doesNotMatch(engine, /nowSec - 5 \* 3600/, '不许再有「最近 5 小时」的兜底：那会让同一个标签变含义');
  assert.match(renderer, /5h 窗 · 本机账本 \$\{money\(sp\.usdTotal\)\}/);
  assert.match(widget, /5h 窗 · 本机账本 \$\{usd\(sp\.usdTotal\)\}/);
  assert.match(widget, /row\.usd > 0 \? usd\(row\.usd\)/);
});

test('美元主行必须与进度条同源，账本数退到副行并标注', () => {
  // 2026-09-23 用户：「$256，但进度条和实际这么多」。根子是两个来源并排摆：
  // 进度条/百分比/满额/余都是**官方点数**算的，而主行是**本机账本**——用户只会读成「算错了」。
  // 钉住：主行 = 官方点数 × 汇率（scaledSpentUSD），账本数降到副行且写明口径不同。
  // 两个显示面（桌面面板 + 内嵌 widget）必须一致，不许一个讲一套。
  assert.match(renderer, /const officialUsed = w\.scaledSpentUSD;/);
  assert.match(renderer, /mainText = money\(officialUsed \?\? w\.spentUSD \?\? 0\)/);
  assert.match(renderer, /本机账本 <b>/);
  assert.match(widget, /const officialUsed = w\.scaledSpentUSD;/);
  assert.match(widget, /usd\(officialUsed \?\? w\.spentUSD \?\? 0\)/);
  assert.match(widget, /'本机账本 ' \+ usd/);
});

test('每个模型的实测倍率都要报，且每个模型用它自己那个池当计数器', () => {
  // 「哪个模型对不上」是整窗比值答不了的。2026-09-23 实查两轮：
  //  ① 只报配置过的组（fable）时，本机最大那笔 claude-opus-5 完全看不见；
  //  ② 用**总池**当计数器量它得 ×0.000（看着像「官方不扣点」，差点据此去改残差口径），
  //     换成 **7d_claude 分池**得 ×1.000——池是互不相交的，拿总池量分池里的模型恒得 0。
  assert.match(renderer, /latest\?\.pointCostModels/);
  assert.match(renderer, /实测倍率偏离 1/);
  assert.match(engine, /#pointCostModels\(/);
  assert.match(engine, /out\.pointCostModels = /);
  assert.match(engine, /measurePerModel\(this\.calibrator\.points/, '选池与测量只许有一份实现');
  const lib = readFileSync(new URL('../provider/lib/rate-measure.mjs', import.meta.url), 'utf8');
  assert.match(lib, /export function measurePerModel/);
  assert.match(lib, /Claude 模型的点扣在 `7d_claude` 分池里/, '为什么不能拿总池量：写进注释，别再犯');
  const cli = readFileSync(new URL('../scripts/store-migrate.mjs', import.meta.url), 'utf8');
  assert.match(cli, /measurePerModel\(byLabel, marksFromStore\(store\), wins\)/, 'CLI 也要能看（不开界面）');
});

test('未计价的调用在账目里单列，不静默成 0', () => {
  // 「用了什么就记什么」：没价目的模型美元是 0（不猜价），但 token 是实打实花掉的。
  // 报表里不写出来，那一列就是静默的 0——用户看到的会是「这笔没记账」。
  assert.match(renderer, /l\.unpriced/);
  assert.match(renderer, /未计价/);
  assert.match(renderer, /--reprice/, '要给出「补了价目怎么修历史」的那条命令');
  assert.match(engine, /store\.unpriced\(from, now\)/, '引擎侧要真的产出这个块');
});

test('the ledger report splits task/workspace/session and admits the unattributed part', () => {
  // 「分析每一个任务到底花费多少」是用户 2026-09-23 明确要的。旧账本只有「模型 × 分钟」的桶，
  // 结构上问不出来；现在流水每笔带会话、turns 表补任务归属，所以能出。两条必须钉住：
  // 报表真的画出来，以及**归不上的部分如实单列**——轮次只覆盖 Mirasim 管起来的会话
  // （实测 1201 轮里 1068 轮有 taskId），摊到别的任务头上就是编数。
  assert.match(renderer, /renderLedger\(p\.ledger\)/);
  assert.match(renderer, /id="ledgerReport"/);
  assert.match(renderer, /归不上的/);
  assert.match(renderer, /不摊派/);
  assert.match(renderer, /能归到任务的/);
  // 引擎侧要真的产出这个块（三条 payload 路径都给），否则界面那段永远不触发
  assert.match(engine, /ledger: r/);
  assert.match(engine, /#ledgerReport\(/);
  assert.match(engine, /store\.byTask\(/);
  assert.match(engine, /LEDGER_REPORT_EVERY/, '报表要缓存——payload 每跳都算，扫 8 天明细会白烧 CPU');
});

test('the three dollar-trust alarms name the culprit and say what to do about it', () => {
  // 2026-09-22：这三条都是「静默成功」型的偏差——价目兜底猜、transcript 漏账、外机分片旧
  // 口径。每一条的表现都只是一个偏了的美元数，用户无从解释，所以必须点名 + 给动作；
  // 只写「可能有偏差」等于没写。引擎侧也要真的产出这三个字段，否则界面这几段永不触发。
  assert.match(renderer, /p\.guessedPrices\?\.length/);
  assert.match(renderer, /补进内置表/);
  assert.match(renderer, /p\.sourceGaps\?\.length/);
  assert.match(renderer, /~\/\.claude\/projects/);
  assert.match(renderer, /p\.staleShards\?\.length/);
  assert.match(renderer, /升到本版并让它重建账本/);
  assert.match(engine, /guessedPrices: guessed/);
  assert.match(engine, /sourceGaps: gaps\.slice/);
  assert.match(engine, /staleShards: stale/);
});

test('账号池页把 fleet-dao 的每个池 × 窗口都画出来，不是现值的都挂标记，令牌不进页面', () => {
  // 2026-09-24：fleet-dao 的额度表成为唯一来源，MiraQuota 变成它的桌面窗口。
  assert.match(renderer, /<button id="tabPools">账号池<\/button>/);
  assert.match(renderer, /pools: \['tabPools', 'pagePools'\]/);
  assert.match(renderer, /renderPools\(p\.fleet\)/);
  assert.match(engine, /fleet: this\.fleet\.status\(\)/, '引擎每条 payload 路径都要给这一块');
  // 三种「不是现值」各有一枚标记：估算、上游这次没报、过了有效期
  assert.match(renderer, /chip est[^>]*>估算</);
  assert.match(renderer, />上游这次没报</);
  assert.match(renderer, /读数超过有效期/);
  assert.match(renderer, /w\.resetsAt != null \? fmtReset\(w\.resetsAt\)/, '清零倒计时');
  // 没读成要说原因，不许装成「没有池」；「上游明说 0 个池」另有一句
  assert.match(renderer, /这次没读成：/);
  assert.match(renderer, /这次没读到 fleet-dao：/);
  assert.match(renderer, /fleet-dao 说它没有配置任何账号池/);
  // 设置：地址 + 只读令牌（密码框）；令牌不回显、不进浏览器存储
  assert.match(renderer, /id="fleetToken" type="password"/);
  assert.match(renderer, /\$\('fleetToken'\)\.value = '';/);
  assert.doesNotMatch(renderer, /localStorage\.setItem\([^)]*[Tt]oken/);
  const preload = readFileSync(new URL('../app/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /fleetConnect: \(opts\) => ipcRenderer\.invoke\('fleet:connect', opts\)/);
  assert.match(preload, /fleetDisconnect: \(\) => ipcRenderer\.invoke\('fleet:disconnect'\)/);
});
