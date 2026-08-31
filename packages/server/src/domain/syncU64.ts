/**
 * u64 十进制字符串解析与比较（§8.1.8：baseVersion/expectedStateVersion 须可解析为
 * unsigned 64-bit 十进制，否则 400 VALIDATION_FAILED）。
 *
 * 约定：sync 域所有 u64 协议字段（keyEpoch / stateVersion / changeSequence / record
 * version / envelope version / receipt result 字段）在内存表示为十进制字符串，签名、
 * 游标、签名覆盖值全程保持字符串原样；数值比较一律经 BigInt，**禁用 Number() 有损转换**。
 */

export const U64_MAX = 2n ** 64n - 1n;

/** 校验并解析十进制 u64 字符串；非法（非纯数字 / 前导零 / 越界）抛错。 */
export function parseU64(input: string): bigint {
  if (input === '') throw new RangeError(`not a u64 decimal: empty`);
  // 仅允许 1..n 位十进制数字（禁前导零，除非就是单个 "0"）。
  if (!/^[0-9]+$/.test(input)) throw new RangeError(`not a u64 decimal: ${JSON.stringify(input)}`);
  if (input.length > 1 && input[0] === '0') throw new RangeError(`leading zero: ${JSON.stringify(input)}`);
  const v = BigInt(input);
  if (v < 0n || v > U64_MAX) throw new RangeError(`out of u64 range: ${JSON.stringify(input)}`);
  return v;
}

/** 校验十进制 u64；合法返回 true，否则 false（用于路由侧返回 400）。 */
export function isU64(input: string): boolean {
  try {
    parseU64(input);
    return true;
  } catch {
    return false;
  }
}

/** 大整数加一，返回十进制字符串（用于 stateVersion/changed_sequence 自增，永不损失精度）。溢出抛错。 */
export function incU64(input: string): string {
  const v = parseU64(input);
  if (v >= U64_MAX) throw new RangeError(`increment overflows u64: ${JSON.stringify(input)}`);
  return (v + 1n).toString();
}