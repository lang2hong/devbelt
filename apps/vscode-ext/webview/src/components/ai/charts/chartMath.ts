/**
 * 图表纯函数（无 DOM / Vue 依赖，可在扩展侧单测中直接导入）：
 * 轴刻度 / 数值格式 / 文本宽度估算 / 标签截断与公共前缀折叠。
 */

/** 11px 等宽近似字符宽（用于标签截断估算；CJK 按 2 倍计）。 */
const CHAR_W = 6.4;

/** 轴/标注用数值格式：大数压缩（12.3K / 3.4M），其余去尾零。 */
export function fmtChartValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${Number((v / 1_000_000).toFixed(1))}M`;
  if (abs >= 10_000) return `${Number((v / 1_000).toFixed(1))}K`;
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(2)));
}

/**
 * nice ticks：以 1/2/5×10^n 为步长生成 [0, ≥max] 区间刻度（含 0 基线）。
 * 最后一个刻度**必须 ≥ max**，否则最高的柱/点会冲出绘图区。
 */
export function niceTicks(max: number, count = 4): number[] {
  const top = Math.max(max, 0);
  if (top === 0) return [0, 1];
  const rawStep = top / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [0];
  while (ticks[ticks.length - 1]! < top - step * 1e-9) {
    ticks.push(Number((ticks.length * step).toFixed(10)));
  }
  return ticks;
}

/**
 * 跨 0 的刻度：覆盖 [min, max]，步长取 1/2/5×10^n。
 * 折线图允许负值时必须用这个，不能沿用「从 0 起」的 `niceTicks`。
 */
export function niceTicksRange(min: number, max: number, count = 4): number[] {
  const lo = Math.min(min, 0);
  const hi = Math.max(max, 0);
  if (lo === hi) return [0, 1];
  const rawStep = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/** 文本显示宽度估算（px，11px 字号；CJK 字符按双宽）。 */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? CHAR_W * 2 : CHAR_W;
  return w;
}

/**
 * 按像素宽截断：普通文本尾部 …；已折叠前缀（以 … 开头）的标签**保留尾段**
 * （区分度在尾部，截尾会让 ID 重新变得一样）。
 */
export function fitLabel(s: string, maxPx: number): string {
  const text = String(s ?? '');
  if (textWidth(text) <= maxPx) return text;
  if (text.startsWith('…')) {
    const chars = [...text.slice(1)];
    let tail = '';
    for (let i = chars.length - 1; i >= 0; i--) {
      if (textWidth(`…${chars[i]}${tail}`) > maxPx) break;
      tail = `${chars[i]}${tail}`;
    }
    return `…${tail}`;
  }
  let out = '';
  for (const ch of text) {
    if (textWidth(`${out}${ch}…`) > maxPx) break;
    out += ch;
  }
  return out ? `${out}…` : '…';
}

/**
 * 智能标签：所有标签共享较长公共前缀（如雪花 ID `2085274117…`、`ORD2026…` 单号）时
 * 去掉前缀只显示有区分度的尾段（`…251266`）；完整值留在悬停提示。
 * 至少保留 4 个字符，前缀 < 4 个字符或仅 1 项时原样返回。
 */
export function smartLabels(values: string[]): string[] {
  const list = values.map((v) => String(v ?? '').trim());
  if (list.length < 2) return list;
  let prefix = list[0]!;
  for (const v of list) {
    let i = 0;
    while (i < prefix.length && i < v.length && prefix[i] === v[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  const minLen = Math.min(...list.map((v) => v.length));
  // 保留至少 4 个字符的区分段
  const cut = Math.min(prefix.length, Math.max(minLen - 4, 0));
  if (cut < 4) return list;
  return list.map((v) => `…${v.slice(cut)}`);
}
