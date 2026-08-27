/** 窗口标签工具，供各模块共用。 */

/** 窗口长度（秒），由标签解析（"5h" / "7d" / "7d_fable"）。无法解析返回 null。 */
export function windowDuration(label) {
  const m = String(label).match(/^(\d+(?:\.\d+)?)\s*([mhdw])/i);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    case 'w': return n * 604800;
    default: return null;
  }
}

/** 模型档位组名，取窗口名下划线之后的部分（`7d_fable` → `fable`）。无则 null。 */
export function modelGroup(label) {
  const idx = String(label).lastIndexOf('_');
  if (idx < 0) return null;
  const g = label.slice(idx + 1).toLowerCase();
  return g || null;
}
