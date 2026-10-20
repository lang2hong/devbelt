/**
 * 带符号十进制文本（整数或小数）：`-12`、`+1.50`、`9007199254740993`。
 * 指数、十六进制、`NaN`/`Infinity` 不在此列，交给 Number 分支。
 */
const DECIMAL_TEXT = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * 结果网格本地排序的单元格比较器。
 *
 * 十进制文本用 BigInt 比较：BIGINT 的字符串可超过 2^53，先转 Number 会把
 * 相邻 ID 折叠成同一个值（排序结果错乱）；带标度的 DECIMAL 同样会丢精度，
 * 所以按最大小数位补零后逐位比较。其余数字（指数、十六进制等）沿用
 * Number，非数字回退本地化字符串比较。
 *
 * null/undefined 的排序策略由调用方决定（结果视图要求恒排末尾，不随方向
 * 翻转），本函数不接管；空串与纯空白也不当作数字。
 */
export function compareCellValues(a: unknown, b: unknown): number {
  const sa = String(a);
  const sb = String(b);
  if (sa.trim() === '' || sb.trim() === '') return sa.localeCompare(sb);
  const decimal = compareDecimalText(sa, sb);
  if (decimal !== null) return decimal;
  const na = typeof a === 'number' ? a : Number(a);
  const nb = typeof b === 'number' ? b : Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  return sa.localeCompare(sb);
}

/**
 * 两个十进制文本的数值比较；任一不是十进制文本时返回 null。
 *
 * 符号单独取出，整数与小数补零后拼成 BigInt 比较，避免 `-0` 与 `0` 不等、
 * 以及不同标度（`1.5` vs `1.50`）被当成不同值。
 */
function compareDecimalText(sa: string, sb: string): number | null {
  const ma = DECIMAL_TEXT.exec(sa);
  const mb = DECIMAL_TEXT.exec(sb);
  if (!ma || !mb) return null;
  const scale = Math.max(ma[3]?.length ?? 0, mb[3]?.length ?? 0);
  const ia = BigInt(ma[2] + (ma[3] ?? '').padEnd(scale, '0'));
  const ib = BigInt(mb[2] + (mb[3] ?? '').padEnd(scale, '0'));
  if (ia === ib) return 0;
  const negA = ma[1] === '-';
  const negB = mb[1] === '-';
  if (negA !== negB) return negA ? -1 : 1;
  return (ia < ib ? -1 : 1) * (negA ? -1 : 1);
}