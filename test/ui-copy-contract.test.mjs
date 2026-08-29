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

test('full-dollar labels say points-derived instead of official billing', () => {
  assert.match(renderer, /点数反推/);
  assert.doesNotMatch(renderer, /<span class="tag">官<\/span>/);
  assert.doesNotMatch(widget, /cals\.push\('官 '/);
});
