import test from 'node:test';
import assert from 'node:assert/strict';

import {
  familyLabel,
  isBillableCloudUsage,
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
