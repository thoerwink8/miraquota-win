/** 模型家族归类与最近模型任务汇总。 */

const FAMILY_RULES = [
  ['claude', 'Claude', /(?:^|\/)claude-|^claude-/i],
  ['gpt', 'GPT', /(?:^|\/)(?:gpt-|openai-gpt-)|^gpt-/i],
  ['grok', 'Grok', /(?:^|\/)(?:grok-|x-ai\/grok-|xai\/grok-)|^grok-/i],
  ['qwen', 'Qwen', /(?:^|\/)qwen(?:[\d-]|$)|^qwen/i],
  ['deepseek', 'DeepSeek', /(?:^|\/)deepseek(?:[\d-]|$)|^deepseek/i],
  ['glm', 'GLM', /(?:^|\/)(?:glm-|z-ai\/glm-|zai-org\/glm-)|^glm-/i],
  ['kimi', 'Kimi', /(?:^|\/)(?:kimi-|moonshotai\/kimi-)|^kimi/i],
];

/** 家族 id → 展示名（未知 id 首字母大写兜底）。 */
export function familyLabel(id) {
  const rule = FAMILY_RULES.find(([fid]) => fid === id);
  if (rule) return rule[1];
  const s = String(id || '');
  return s ? s[0].toUpperCase() + s.slice(1) : '未知';
}

export function modelFamily(rawModel) {
  const model = String(rawModel || '').trim();
  if (!model) return { id: 'unknown', label: '未知' };
  for (const [id, label, pattern] of FAMILY_RULES) if (pattern.test(model)) return { id, label };
  const tail = model.slice(model.lastIndexOf('/') + 1).trim();
  const token = (tail.split(/[-_.\s]+/)[0] || 'other').toLowerCase();
  return { id: token.replace(/[^a-z0-9]+/g, '') || 'other', label: token[0]?.toUpperCase() + token.slice(1) };
}

export function isBillableCloudUsage(row) {
  return row?.status === 200 && row?.viaRelay === true && row?.leg === 'relay'
    && String(row?.upstreamHost || '').toLowerCase() === 'relay.mirasim.ai'
    && row?.modelSource !== 'dispatch' && typeof row?.model === 'string' && row.model.length > 0;
}

export function recentConcreteModels(samples, modelCap = 5, taskCap = 5) {
  const byModel = new Map();
  for (const sample of samples || []) {
    if (!sample?.model) continue;
    if (!byModel.has(sample.model)) byModel.set(sample.model, []);
    byModel.get(sample.model).push(sample);
  }
  return [...byModel.entries()].map(([modelId, tasks]) => {
    const sorted = [...tasks].sort((a, b) => b.at - a.at);
    return {
      modelId,
      family: modelFamily(modelId),
      latestAt: sorted[0]?.at ?? 0,
      tasks: sorted.slice(0, taskCap),
    };
  }).sort((a, b) => b.latestAt - a.latestAt).slice(0, modelCap);
}
