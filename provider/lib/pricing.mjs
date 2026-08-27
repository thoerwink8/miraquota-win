/**
 * 价目表。优先读 Mirasim 的 models.dev 缓存，缺失时回退内置表。
 * 绝对金额受未建模的长上下文溢价影响，但标定与计量共用同一张表，比例一致，
 * 故占比结论不受该偏差影响。移植自 Swift 版 Pricing.swift。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODELS_CACHE = join(homedir(), '.mirasim', 'models-dev-cache.json');

// 美元 / 百万 token：[input, output, cacheRead, cacheWrite]
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

export class Pricing {
  constructor() {
    const loaded = Pricing.#loadCache();
    if (loaded && Object.keys(loaded).length >= 5) {
      this.table = { ...BUILTIN, ...loaded };
      this.source = 'models.dev cache';
    } else {
      this.table = { ...BUILTIN };
      this.source = 'builtin';
    }
  }

  static #loadCache() {
    try {
      const root = JSON.parse(readFileSync(MODELS_CACHE, 'utf8'));
      const models = root?.data?.anthropic?.models;
      if (!models) return null;
      const out = {};
      for (const [id, m] of Object.entries(models)) {
        const c = m?.cost;
        if (typeof c?.input !== 'number' || typeof c?.output !== 'number') continue;
        out[id] = [c.input, c.output, c.cache_read ?? c.input * 0.1, c.cache_write ?? c.input * 1.25];
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
    const id = Pricing.normalize(rawModel);
    if (this.table[id]) return this.table[id];

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
