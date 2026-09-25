/**
 * 连接颜色标签 → VS Code 主题色 token。
 *
 * `ThemeIcon` 的 `ThemeColor` 只接受主题色 id（不接受任意 hex），所以把用户填的 hex
 * 按色相归一到固定的 `charts.*` 调色板，得到可用的彩色连接图标；近灰色/非法值返回
 * undefined（回退到原有按环境的颜色）。
 */
const TOKENS = ['charts.red', 'charts.orange', 'charts.yellow', 'charts.green', 'charts.blue', 'charts.purple'] as const;

/** hex（`#rrggbb` 或 `rrggbb`）→ 主题色 token；无法映射时 undefined。 */
export function connectionColorToken(color?: string): string | undefined {
  if (!color) return undefined;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return undefined;
  const hex = m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 24) return undefined; // 近灰：无有意义色相
  let hue: number;
  if (max === r) hue = ((g - b) / (max - min)) * 60;
  else if (max === g) hue = (2 + (b - r) / (max - min)) * 60;
  else hue = (4 + (r - g) / (max - min)) * 60;
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 345) return TOKENS[0];
  if (hue < 45) return TOKENS[1];
  if (hue < 70) return TOKENS[2];
  if (hue < 165) return TOKENS[3];
  if (hue < 260) return TOKENS[4];
  return TOKENS[5];
}
