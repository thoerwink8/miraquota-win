import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  familyLabel,
  isBillableCloudUsage,
  isRelayCharged,
  modelFamily,
  recentConcreteModels,
} from '../provider/lib/model-families.mjs';
import { Pricing } from '../provider/lib/pricing.mjs';

test('Claude variants including Fable collapse into one family', () => {
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5']) {
    assert.deepEqual(modelFamily(model), { id: 'claude', label: 'Claude' });
  }
});

test('GPT variants collapse into one family', () => {
  for (const model of ['gpt-5.6-sol', 'openai/gpt-5.6-luna', 'gpt-5.5']) {
    assert.deepEqual(modelFamily(model), { id: 'gpt', label: 'GPT' });
  }
});

test('only real relay usage enters billing family choices', () => {
  const cloud = { model: 'claude-opus-5', status: 200, viaRelay: true, leg: 'relay', upstreamHost: 'relay.mirasim.ai' };
  assert.equal(isBillableCloudUsage(cloud), true);
  assert.equal(isBillableCloudUsage({ ...cloud, modelSource: 'dispatch' }), false);
  assert.equal(isBillableCloudUsage({ ...cloud, viaRelay: false, leg: 'direct' }), false);
});

test('family ids map to display labels with a capitalized fallback', () => {
  assert.equal(familyLabel('claude'), 'Claude');
  assert.equal(familyLabel('gpt'), 'GPT');
  assert.equal(familyLabel('mistral'), 'Mistral');
});

test('speed rows keep the five most recent concrete models and five tasks each', () => {
  const samples = [];
  for (let model = 1; model <= 6; model++) {
    for (let task = 1; task <= 7; task++) {
      samples.push({ id: `${model}-${task}`, model: `local-model-${model}`, at: model * 100 + task, ms: 1000, out: 100 });
    }
  }
  const rows = recentConcreteModels(samples);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].modelId, 'local-model-6');
  assert.equal(rows.at(-1).modelId, 'local-model-2');
  assert.equal(rows[0].tasks.length, 5);
  assert.deepEqual(rows[0].tasks.map((task) => task.id), ['6-7', '6-6', '6-5', '6-4', '6-3']);
});

test('pricing cache supplements GPT models used by the official relay', () => {
  const pricing = new Pricing();
  assert.ok(pricing.price('gpt-5.6-sol'));
  assert.ok(pricing.cost('gpt-5.6-sol', 1000, 100, 0, 0) > 0);
});

test('every successful relay call is charged, dispatch included, and gets a source label', () => {
  // 账本一行都不许静默丢（用户 2026-09-02）：dispatch 是 Mirasim 自己发的中继调用，点照扣，
  // 只是不该混进用户选的计费家族——所以按来源单列一个「调度」家族。
  const cloud = { model: 'claude-haiku-4-5', status: 200, viaRelay: true, leg: 'relay', upstreamHost: 'relay.mirasim.ai' };
  assert.equal(isRelayCharged(cloud), true);
  assert.equal(isRelayCharged({ ...cloud, modelSource: 'dispatch' }), true);
  assert.equal(isRelayCharged({ ...cloud, upstreamHost: 'api.anthropic.com', viaRelay: false, leg: 'direct' }), false);
  assert.equal(isRelayCharged({ ...cloud, status: 0 }), false);
  assert.equal(familyLabel('dispatch'), '调度');
});

test('pricing reads every provider in the models cache, official sources first', () => {
  // 早先只读 anthropic 与 ai-router：kimi/gemini/qwen/glm 查不到价，账本整行丢掉还不出声。
  const file = join(mkdtempSync(join(tmpdir(), 'mq-price-')), 'models.json');
  writeFileSync(file, JSON.stringify({ data: {
    zzz: { models: { 'kimi-k3': { cost: { input: 9, output: 9 } }, 'gpt-5.6-sol': { cost: { input: 1, output: 1 } } } },
    'ai-router': { models: { 'gpt-5.6-sol': { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } } } },
    google: { models: { 'gemini-3.7-flash': { cost: { input: 0.3, output: 2.5 } } } },
  } }));
  const p = new Pricing(file);
  assert.deepEqual(p.price('gpt-5.6-sol').slice(0, 2), [5, 30], '官方源优先，不被别家标价盖掉');
  assert.equal(p.price('kimi-k3')[0], 9, '其余 provider 兜底');
  assert.equal(p.price('google/gemini-3.7-flash')[1], 2.5, '「厂商/模型」写法剥掉厂商再查');
  assert.equal(p.price('claude-opus-5')[0], 5, '内置官方表仍在');
  assert.equal(p.price('no-such-model'), null);
});
