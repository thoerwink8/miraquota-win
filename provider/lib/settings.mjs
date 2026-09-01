/**
 * 用户可调口径（2026-09-02 用户拍板）。存 ~/.miraquota/settings.json，与账本、同步配置同级：
 * 放 home 而不是安装目录，自动更新覆盖程序文件也不会丢设置。
 *
 * 目前只有一项：模型档位组的点数计量倍率。官方说明 fable 资源紧张、点数按 2 倍计量
 * （截图 2026-09-01），所以同样一份 API 等价支出，走 fable 扣掉的点是走 opus 的 2 倍。
 * 不折算就会把整池价值系统性低估（本机实测：不分组 $2490 vs 按 2× 折算 $3618）。
 *
 * 做成可调而不是写死 2：① 官方随时可能改比例，改配置比改代码快；② 本机实测倍率
 * （非 fable 单价 ÷ fable 单价）当下是 2.39×，用户可以自己对表、自己定。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SETTINGS_FILE = join(homedir(), '.miraquota', 'settings.json');

/** 默认倍率表：键是窗口档位组名（`7d_fable` → `fable`），值是该组的点数计量倍率。 */
export const DEFAULT_GROUP_POINT_COST = { fable: 2 };
/** 允许的倍率区间：1 = 与普通模型同价；上限给足官方调整余地，超界视为手滑，回默认。 */
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 10;

export function clampRatio(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_RATIO || n > MAX_RATIO) return null;
  return n;
}

export class Settings {
  /** @param file 配置文件路径（测试注入用，默认 ~/.miraquota/settings.json） */
  constructor(file = SETTINGS_FILE) {
    this.file = file;
    this.groupPointCost = { ...DEFAULT_GROUP_POINT_COST };
    this.load();
  }

  /** 读盘。文件缺失/损坏/字段非法都回默认——设置读不出来不该拖垮取数主流程。 */
  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const table = { ...DEFAULT_GROUP_POINT_COST };
      for (const [group, value] of Object.entries(raw?.groupPointCost ?? {})) {
        const ratio = clampRatio(value);
        if (ratio != null) table[group] = ratio;
      }
      this.groupPointCost = table;
    } catch { this.groupPointCost = { ...DEFAULT_GROUP_POINT_COST }; }
    return this.groupPointCost;
  }

  /** 某组的倍率；未配置的组一律 1（不认识的档位不该被凭空加权）。 */
  ratioOf(group) {
    if (!group) return 1;
    return this.groupPointCost[group] ?? 1;
  }

  /**
   * 改一个组的倍率并落盘。非法值原样拒绝（返回 false），不写坏文件、不改内存值。
   * 写盘失败也返回 false：让调用方能如实告诉用户「没存上」，而不是下次打开才发现。
   */
  setGroupRatio(group, value) {
    const ratio = clampRatio(value);
    if (!group || ratio == null) return false;
    const next = { ...this.groupPointCost, [group]: ratio };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ groupPointCost: next }, null, 2) + '\n');
    } catch { return false; }
    this.groupPointCost = next;
    return true;
  }
}
