const INTEGER_TEXT = /^[+-]?\d+$/;

/**
 * 结果网格本地排序的单元格比较器。
 *
 * 整数文本用 BigInt 比较：BIGINT 的十进制字符串可超过 2^53，先转 Number 会把
 * 相邻 ID 折叠成同一个值（排序结果错乱），BigInt 保持逐位精确。
 * 其余数字沿用 Number，非数字回退本地化字符串比较。
 */
export function compareCellValues(a: unknown, b: unknown): number {
  const sa = String(a);
  const sb = String(b);
  if (INTEGER_TEXT.test(sa) && INTEGER_TEXT.test(sb)) {
    const ba = BigInt(sa);
    const bb = BigInt(sb);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  }
  const na = typeof a === 'number' ? a : Number(a);
  const nb = typeof b === 'number' ? b : Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  return sa.localeCompare(sb);
}