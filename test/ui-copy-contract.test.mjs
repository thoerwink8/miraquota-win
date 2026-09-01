import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const renderer = readFileSync(new URL('../app/renderer/index.html', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../widget/miraquota-widget.js', import.meta.url), 'utf8');

test('new users start in the authoritative points mode', () => {
  assert.match(renderer, /let MODE = 'pts';/);
  assert.match(renderer, /<button id="modePts" class="on">点<\/button>/);
  assert.match(renderer, /<button id="modeUsd">\$<\/button>/);
});

test('account-level dollar values are visibly approximate in the embedded widget', () => {
  assert.match(widget, /primary\.scaledSpentUSD != null[\s\S]*?\n\s*\? '≈' \+ usd\(primary\.scaledSpentUSD\)/);
  assert.match(widget, /`余 ≈\$\{usd\(w\.remainingUSD\)\}`/);
});

test('full-dollar labels distinguish official points from local prediction', () => {
  assert.match(renderer, /点数反推/);
  assert.match(renderer, /cals\.push\(`<span class="tag">官≈<\/span><b>\$\{money\(w\.fullUSDOfficial, 0\)\}/);
  assert.match(renderer, /cals\.push\(`<span class="tag">预≈<\/span><b>\$\{money\(w\.fullUSD, 0\)\}/);
  assert.match(widget, /cals\.push\('官≈' \+ usd\(w\.fullUSDOfficial\)/);
  assert.match(widget, /cals\.push\('预≈' \+ usd\(w\.fullUSD\)/);
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
  // 未配置（payload 无 sync）时：页签不出现，且这一页不可被激活（记住的页签也挡回总览）
  assert.match(renderer, /\$\('tabSync'\)\.style\.display = sy \? '' : 'none';/);
  assert.match(renderer, /name === 'sync' && !syncAvailable/);
  assert.match(renderer, /if \(!sy && \$\('pageSync'\)\.classList\.contains\('on'\)\) switchTab\('main'\)/);
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
  assert.match(renderer, /'GitHub 已接入'/);
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
