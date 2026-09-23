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

// 美元 / 百万 token：[input, output, cacheRead, cacheWrite]
// 官方价来源：Anthropic API 价目（2026-08 核对，2026-09-22 补 Fable 5.1 与 Opus 5.5）。
// 注意 $15/$75 是上代 Opus 4/4.1 的旧价，Opus 5/4.8 官方价即 $5/$25，Fable 5 即 $10/$50
// ——勿按旧价"纠正"本表。
//
// **缓存读不再一律是 input 的 10%**：Fable 5.1 是 $0.25（Fable 5 的 1/4，同代 input 同价）、
// Opus 5.5 是 $0.20（不是 $4 的 10%）。这一列填错的代价被缓存读的体量放大——本机实测
// 缓存读占 fable 花费的 56%，按 Fable 5 的 $1.00 记 5.1 会把账本抬高一倍多，倍率随之全错。
// 新模型进表时逐项查官方价目，别按「10%/125%」推。
const BUILTIN = {
  'claude-opus-5-5':   [4, 20, 0.2, 5],
  'claude-opus-5':     [5, 25, 0.5, 6.25],
  'claude-opus-4-8':   [5, 25, 0.5, 6.25],
  'claude-opus-4-7':   [5, 25, 0.5, 6.25],
  'claude-opus-4-6':   [5, 25, 0.5, 6.25],
  'claude-opus-4-5':   [5, 25, 0.5, 6.25],
  'claude-fable-5-1':  [10, 50, 0.25, 12.5],
  'claude-fable-5':    [10, 50, 1.0, 12.5],
  'claude-sonnet-5':   [2, 10, 0.2, 2.5],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-sonnet-4-5': [3, 15, 0.3, 3.75],
  'claude-haiku-4-5':  [1, 5, 0.1, 1.25],
};

// 系列兜底：认不出版本号时按这一代的当前款算。指向新款而不是老款——没收录的多半是更新的，
// 而 fable 两款的缓存读差 4 倍，猜错方向就是账本偏一大截。
const FAMILY = [
  ['opus', 'claude-opus-5'], ['fable', 'claude-fable-5-1'],
  ['sonnet', 'claude-sonnet-5'], ['haiku', 'claude-haiku-4-5'],
];

// 版本快照后缀：`claude-haiku-4-5-20251001` 是 `claude-haiku-4-5` 的某日快照，**同款同价**。
// 剥掉它不算猜价——否则每个带日期的 id 都会在界面上被点名（2026-09-23 服务器日志实咬：
// 一条 `claude-haiku-4-5-20251001 不在价目表，按 claude-haiku-4-5 的价记账`）。反过来，
// 剥掉的是版本号（`claude-opus-5-5` → `claude-opus-5`）就是**另一个模型**，必须留痕报警——
// 当初那个静默偏高的价正是这么来的。区分二者只看剥掉的那一段是不是纯数字日期。
const SNAPSHOT_SUFFIX = /^\d{6,}$/;

// 缓存里几百个 provider 对同一模型标价不一。官方源优先，其余按名字序兜底——兜底价只用来
// 让 kimi/gemini/qwen/glm 这类模型「有个数」而不是整行消失（用户 2026-09-02）。
const PREFERRED_PROVIDERS = ['anthropic', 'ai-router', 'openai', 'google', 'moonshotai', 'alibaba', 'zhipuai', 'deepseek', 'xai'];

export class Pricing {
  /** @param cachePath 测试注入用；默认读 Mirasim 的 models.dev 缓存 */
  constructor(cachePath = MODELS_CACHE) {
    const loaded = Pricing.#loadCache(cachePath) ?? {};
    this.guessed = new Map();   // 兜底命中的模型 → 借用了哪个键的价（见 #guess）
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

  /**
   * 查价。未收录的标识按日期后缀、再按系列前缀归档，避免整条记录被丢弃造成低估。
   *
   * 兜底命中会被记进 `guessed`：它是**静默成功**的——返回一个看着合理的价，账本照常
   * 出数，只有倍率、满额这些下游量会偏，而偏了没人知道（2026-09-22 实咬：`claude-opus-5-5`
   * 按前缀落到 Opus 5 的 $5/$25/$0.5，官方是 $4/$20/$0.2，非 fable 侧的美元凭空抬高）。
   * 「查不到价」进 unpriced 有人看，「猜了个价」以前没有落点，所以这里留一份并上报界面。
   */
  price(rawModel) {
    let id = Pricing.normalize(rawModel);
    if (this.table[id]) return this.table[id];
    // 「厂商/模型」写法先剥厂商再查
    if (id.includes('/')) {
      const tail = id.slice(id.lastIndexOf('/') + 1);
      if (this.table[tail]) return this.table[tail];
      id = tail;
    }

    const parts = id.split('-');
    while (parts.length > 2) {
      const popped = parts.pop();
      const key = parts.join('-');
      const hit = this.table[key];
      if (hit) return SNAPSHOT_SUFFIX.test(popped) ? hit : this.#guess(id, key, hit);
    }
    for (const [family, key] of FAMILY) {
      if (id.includes(family)) return this.#guess(id, key, this.table[key]);
    }
    return null;
  }

  /** 记下一次兜底并返回那份价。同一个模型只记一次、只喊一次。 */
  #guess(id, via, price) {
    if (!price) return null;
    if (!this.guessed.has(id)) {
      this.guessed.set(id, via);
      console.error(`[pricing] ${id} 不在价目表，按 ${via} 的价记账——查官方价目补进内置表`);
    }
    return price;
  }

  /** 这次运行里被猜过价的模型：[{ model, via }]。空数组 = 每一笔都查到了确切价。 */
  guessedModels() {
    return [...this.guessed.entries()].map(([model, via]) => ({ model, via })).sort((a, b) => a.model.localeCompare(b.model));
  }

  /**
   * 把一批模型 id 过一遍价目表，返回其中靠兜底猜出价的那些。
   *
   * 报警要跟着**账本**走，不是跟着某一次运行走：兜底一旦发生，那些模型的美元就已经记进
   * 账本了；只在解析记录的那一刻记一次的话，重启后这个报警就没了，而账本里被猜出来的
   * 美元还在。所以界面每次出 payload 都拿账本里出现过的 id 重新问一遍价目表。
   */
  guessedAmong(ids) {
    for (const id of ids ?? []) this.price(id);
    return this.guessedModels();
  }

  /** 一次调用的等价美元；未收录模型返回 null（区别于零 token 的 0）。 */
  cost(model, input, output, cacheRead, cacheWrite) {
    const p = this.price(model);
    if (!p) return null;
    return (input * p[0] + output * p[1] + cacheRead * p[2] + cacheWrite * p[3]) / 1_000_000;
  }
}
