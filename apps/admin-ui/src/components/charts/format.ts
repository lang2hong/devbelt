export type ValueKind = 'number' | 'money' | 'tokens';

/** 完整数值（图例/tooltip/表格）。金额入参为分。 */
export function formatValue(n: number, kind: ValueKind = 'number'): string {
  if (kind === 'money') return `¥${(n / 100).toFixed(2)}`;
  if (kind === 'tokens') return formatCompact(n);
  return n.toLocaleString('zh-CN');
}

/** 坐标轴用的紧凑数值。 */
export function formatAxis(n: number, kind: ValueKind = 'number'): string {
  if (kind === 'money') return `¥${formatCompact(Math.round(n / 100))}`;
  return formatCompact(n);
}

export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`;
}