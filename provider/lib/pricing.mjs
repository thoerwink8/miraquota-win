/**
 * 价目表。内置表为权威（Anthropic 官方 API 价，核对于 2026-08-28），
 * Mirasim 的 models.dev 缓存只补内置表没有的模型；与内置表冲突时以内置表为准并打日志，
 * 防止缓存漂移导致价格来源不可审计。
 * 绝对金额受未建模的长上下文溢价影响，但标定与计量共用同一张表，比例一致，
 * 故占比结论不受该偏差影响。移植自 Swift 版 Pricing.swift。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODELS_CACHE = join(homedir(), '.mirasim', 'models-dev-cache.json');

// 美元 / 百万 token：[input, output, cacheRead(=10% input), cacheWrite(=125% input)]
// 官方价来源：Anthropic API 价目（2026-08 核对）。注意 $15/$75 是上代 Opus 4/4.1 的旧价，
// Opus 5/4.8 官方价即 $5/$25，Fable 5 即 $10/$50——勿按旧价"纠正"本表。
const BUILTIN = {
  'claude-opus-5':     [5, 25, 0.5, 6.25],
  'claude-opus-4-8':   [5, 25, 0.5, 6.25],
  'claude-opus-4-7':   [5, 25, 0.5, 6.25],
  'claude-opus-4-6':   [5, 25, 0.5, 6.25],
  'claude-opus-4-5':   [5, 25, 0.5, 6.25],
  'claude-fable-5':    [10, 50, 1.0, 12.5],
  'claude-sonnet-5':   [2, 10, 0.2, 2.5],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-sonnet-4-5': [3, 15, 0.3, 3.75],
  'claude-haiku-4-5':  [1, 5, 0.1, 1.25],
};

const FAMILY = [
  ['opus', 'claude-opus-5'], ['fable', 'claude-fable-5'],
  ['sonnet', 'claude-sonnet-5'], ['haiku', 'claude-haiku-4-5'],
];

// 缓存里几百个 provider 对同一模型标价不一。官方源优先，其余按名字序兜底——兜底价只用来
// 让 kimi/gemini/qwen/glm 这类模型「有个数」而不是整行消失（用户 2026-09-02）。
const PREFERRED_PROVIDERS = ['anthropic', 'ai-router', 'openai', 'google', 'moonshotai', 'alibaba', 'zhipuai', 'deepseek', 'xai'];

export class Pricing {
  /** @param cachePath 测试注入用；默认读 Mirasim 的 models.dev 缓存 */
  constructor(cachePath = MODELS_CACHE) {
    const loaded = Pricing.#loadCache(cachePath) ?? {};
    // 内置官方价权威；缓存只补充未收录模型。冲突仅记录，不覆盖。
    this.table = { ...loaded, ...BUILTIN };
    this.source = Object.keys(loaded).length ? 'builtin(official) + cache补充' : 'builtin(official)';
    for (const [id, p] of Object.entries(loaded)) {
      const b = BUILTIN[id];
      if (b && (b[0] !== p[0] || b[1] !== p[1])) {
        console.error(`[pricing] 缓存价 ${id} [${p[0]},${p[1]}] 与官方内置 [${b[0]},${b[1]}] 不一致，采用内置`);
      }
    }
  }

  static #loadCache(cachePath) {
    try {
      const root = JSON.parse(readFileSync(cachePath, 'utf8'));
      const out = {};
      // 先官方源、再其余全部 provider；同名冲突先写者胜，内置官方表仍在构造器中最高优先。
      // 早先只读 anthropic 与 ai-router，其他模型查不到价就整行被账本丢掉，还不出声。
      const all = Object.keys(root?.data ?? {}).sort();
      const providers = [...PREFERRED_PROVIDERS.filter((p) => all.includes(p)), ...all.filter((p) => !PREFERRED_PROVIDERS.includes(p))];
      for (const provider of providers) {
        const models = root?.data?.[provider]?.models ?? {};
        for (const [id, m] of Object.entries(models)) {
          const c = m?.cost;
          if (typeof c?.input !== 'number' || typeof c?.output !== 'number') continue;
          if (out[id]) continue;
          out[id] = [c.input, c.output, c.cache_read ?? c.input * 0.1, c.cache_write ?? c.input * 1.25];
        }
      }
      return Object.keys(out).length ? out : null;
    } catch { return null; }
  }

  /** 归一化模型标识：剥掉 `[1m]` 一类的上下文后缀。 */
  static normalize(raw) {
    let s = String(raw).trim();
    const bracket = s.indexOf('[');
    if (bracket >= 0) s = s.slice(0, bracket);
    return s;
  }

  /** 查价。未收录的标识按日期后缀、再按系列前缀归档，避免整条记录被丢弃造成低估。 */
  price(rawModel) {
    let id = Pricing.normalize(rawModel);
    if (this.table[id]) return this.table[id];
    // 「厂商/模型」写法先剥厂商再查
    if (id.includes('/')) { const tail = id.slice(id.lastIndexOf('/') + 1); if (this.table[tail]) return this.table[tail]; id = tail; }

    const parts = id.split('-');
    while (parts.length > 2) {
      parts.pop();
      const hit = this.table[parts.join('-')];
      if (hit) return hit;
    }
    for (const [family, key] of FAMILY) {
      if (id.includes(family)) return this.table[key];
    }
    return null;
  }

  /** 一次调用的等价美元；未收录模型返回 null（区别于零 token 的 0）。 */
  cost(model, input, output, cacheRead, cacheWrite) {
    const p = this.price(model);
    if (!p) return null;
    return (input * p[0] + output * p[1] + cacheRead * p[2] + cacheWrite * p[3]) / 1_000_000;
  }
}
