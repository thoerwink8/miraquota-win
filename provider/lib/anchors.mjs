/**
 * 窗口锚点：离线推算的依据。移植自 Swift 版 Anchor.swift，并做一处增强。
 *
 * 额度窗口是固定窗口：知道任意一次的重置时刻，之后每个窗口的边界都可由
 * 「重置时刻 + 整数倍窗口长度」推出。把最后一次实测（含当时的百分比与满额）落盘，
 * Mirasim 关闭后仍能定出当前窗口起点，配合本机账本给出可用估算。
 *
 * 增强：锚点还在同一个窗口期内时，以「锚点百分比 + 此后本机支出折算」为估计，
 * 比 mac 版纯"本机支出 ÷ 满额"多保留了锚点时刻已计入的他人占用；窗口滚动后退回
 * 纯本机口径。两者都只是下界（他人的新占用在本机不可见），界面须标 ≈。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { windowDuration } from './windows.mjs';

const STATE_DIR = join(homedir(), '.miraquota');
const STATE_FILE = join(STATE_DIR, 'anchor.json');
const MAX_AGE = 30 * 86400;   // 锚点过老时滚动误差累积，不再采信

export class AnchorStore {
  constructor() {
    this.anchors = [];      // [{ label, resetAt, duration, capturedAt, usedPercent, budget, used, modelScoped }]
    this.capturedAt = 0;
    try {
      const p = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      this.anchors = p.anchors ?? [];
      this.capturedAt = p.capturedAt ?? 0;
    } catch { /* 首次运行 */ }
  }

  /** 实测快照到达时更新。重置时刻未变时限频落盘（10 分钟刷一次龄期）。 */
  update(windows, capturedSec) {
    const fresh = windows.map((w) => ({
      label: w.label,
      resetAt: w.resetAt,
      duration: windowDuration(w.label),
      capturedAt: capturedSec,
      usedPercent: Math.min(100, w.used / w.budget * 100),
      budget: w.budget,
      used: w.used,
      modelScoped: !!w.modelScoped,
    })).filter((a) => a.duration);
    if (!fresh.length) return;
    const changed = fresh.length !== this.anchors.length
      || fresh.some((a) => !this.anchors.find((b) => b.label === a.label && b.resetAt === a.resetAt));
    this.anchors = fresh;
    this.capturedAt = capturedSec;
    if (changed || capturedSec - (this.#lastWrite ?? 0) > 600) {
      this.#lastWrite = capturedSec;
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify({ anchors: this.anchors, capturedAt: capturedSec }));
      } catch { /* ignore */ }
    }
  }

  #lastWrite;

  get usable() {
    return this.anchors.length > 0 && Date.now() / 1000 - this.capturedAt < MAX_AGE;
  }

  /** 把锚点滚动到覆盖 now 的窗口，返回 { start, end, rolled }。rolled=窗口已换代。 */
  static rollWindow(anchor, nowSec) {
    const d = anchor.duration;
    if (!d) return null;
    let end = anchor.resetAt;
    let rolled = false;
    if (end <= nowSec) {
      const steps = Math.floor((nowSec - end) / d) + 1;
      end += steps * d;
      rolled = true;
    } else if (end - d > nowSec) {
      const steps = Math.ceil((end - d - nowSec) / d);
      end -= steps * d;
      rolled = true;
    }
    return { start: end - d, end, rolled };
  }
}
