/**
 * JCS（RFC 8785 风格）规范化 —— 镜像服务端 `syncCrypto.jcs`。
 *
 * 正确性要求是「与服务端逐字节一致」，故逐字镜像服务端实现（排序键 + JSON.stringify
 * 字符串转义 + String(number) 数字输出 + -0 → "0" + 拒绝非有限数）。本实现仅面向
 * 冻结 DTO 域（null/bool/安全整数 number/string/array/object）；**不宣称**完整
 * RFC 8785 浮点/大数规范化。u64 一律以十进制字符串传入，绝不先转 JS number。
 */

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JcsError';
  }
}

/** RFC 8785 风格的 JCS 规范化（排序键 + JSON 转义）。 */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new JcsError('non-finite number in signing input');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  throw new JcsError(`unsupported type in signing input: ${t}`);
}
