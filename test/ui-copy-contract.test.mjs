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

test('desktop adds a dynamic billing-family picker next to the dollar/points mode', () => {
  assert.match(renderer, /id="billingFamily"/);
  assert.match(renderer, /billingFamilies/);
  assert.match(renderer, /setBillingFamily/);
});

test('speed surfaces expose current-family badges and expandable recent tasks', () => {
  assert.match(renderer, /当前计费/);
  assert.match(renderer, /r\.tasks/);
  assert.match(renderer, /openSpeedModels/);
  assert.match(renderer, /openSpeedModels\.has\(r\.model\)/);
  assert.match(widget, /当前计费/);
  assert.match(widget, /row\.tasks/);
  assert.match(widget, /r\.open = !r\.open/);
});
