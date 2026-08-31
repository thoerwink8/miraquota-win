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
