/**
 * RFC 4648 §6 base32 编解码（字母表 A–Z、2–7，`=` 作 padding）。
 *
 * 仅提供两处入口，配合 `canonicalizeSecret` 使用：
 *  - `decodeBase32Loose`：容错范围**仅限三类**：
 *      (a) 忽略 ASCII 空白（空格/制表/换行）；
 *      (b) 大小写不敏感；
 *      (c) 末尾缺失 padding 自动补齐。
 *    除此以外一律抛错——`0/1/8/9`、全角字母、零宽字符、**中部 padding**、
 *    **非法长度残余类（len%8 ∈ {1,3,6}）** 都拒绝，不做"尽力解码"或跳过非法字符，
 *    避免 secret 被静默错解。
 *  - `encodeBase32UpperCaseNoPadding`：输出大写、无 padding 的规范形态，
 *    作为 SecretStorage 存储与导出的统一形式。
 *
 * 位运算注意：JS 位移受 32 位有符号整数限制，<<32 会溢出回自身，
 * 因此编解码统一用 BigInt 承载 5 字节→40bit 的中间缓冲。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PADDING = '=';

/** 字母 → 5bit 值；大小写均接受。 */
const DECODE_TABLE: Record<string, number> = /* @__PURE__ */ (() => {
  const t: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET[i]] = i;
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET[i].toLowerCase()] = i;
  return t;
})();

function isAsciiWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

export function decodeBase32Loose(s: string): Uint8Array {
  // 1) 去 ASCII 空白，得到紧凑字符序列（仍可能含尾部 padding）
  let compact = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = ch.charCodeAt(0);
    if (code < 128 && isAsciiWhitespace(code)) continue;
    compact += ch;
  }
  if (compact.length === 0) return new Uint8Array(0);

  // 2) padding 只允许出现在尾部（中部出现即非法，不静默跳过）
  const firstPad = compact.indexOf(PADDING);
  let upper = '';
  if (firstPad >= 0) {
    for (let i = firstPad; i < compact.length; i++) {
      if (compact[i] !== PADDING) throw new Error('invalid base32 padding position');
    }
    const data = compact.slice(0, firstPad);
    upper = validateAndUpper(data);
  } else {
    upper = validateAndUpper(compact);
  }

  // 3) 非法残余类：合法 base32 数据长度 mod 8 ∈ {0,2,4,5,7}
  const residue = upper.length % 8;
  if (residue === 1 || residue === 3 || residue === 6) {
    throw new Error('invalid base32 length');
  }
  // 补齐到整组 8 字符（缺省 padding）
  const padded = residue === 0 ? upper : upper + PADDING.repeat(8 - residue);

  const out: number[] = [];
  for (let i = 0; i < padded.length; i += 8) {
    const a = DECODE_TABLE[padded[i]] ?? 0;
    const b = DECODE_TABLE[padded[i + 1]] ?? 0;
    const c = DECODE_TABLE[padded[i + 2]] ?? 0;
    const d = DECODE_TABLE[padded[i + 3]] ?? 0;
    const e = DECODE_TABLE[padded[i + 4]] ?? 0;
    const f = DECODE_TABLE[padded[i + 5]] ?? 0;
    const g = DECODE_TABLE[padded[i + 6]] ?? 0;
    const h = DECODE_TABLE[padded[i + 7]] ?? 0;
    // 统计本组有效字符数（非 '='），据此决定输出字节数：
    //   2 → 1 字节；4 → 2 字节；5 → 3 字节；7 → 4 字节；8 → 5 字节
    let nonPad = 8;
    for (let k = 7; k >= 0; k--) {
      if (padded[i + k] === PADDING) nonPad--;
      else break;
    }
    // 40-bit buffer via BigInt to avoid 32-bit shift wrap
    const buf = (BigInt(a) << 35n) | (BigInt(b) << 30n) | (BigInt(c) << 25n) | (BigInt(d) << 20n) |
      (BigInt(e) << 15n) | (BigInt(f) << 10n) | (BigInt(g) << 5n) | BigInt(h);
    out.push(Number((buf >> 32n) & 0xffn));
    if (nonPad >= 4) out.push(Number((buf >> 24n) & 0xffn));
    if (nonPad >= 5) out.push(Number((buf >> 16n) & 0xffn));
    if (nonPad >= 7) out.push(Number((buf >> 8n) & 0xffn));
    if (nonPad >= 8) out.push(Number(buf & 0xffn));
  }
  return new Uint8Array(out);
}

/** 校验每个字符属于 RFC 4648 §6 字母表（A–Z / a–z / 2–7）并统一大写；非法字符抛错。 */
function validateAndUpper(data: string): string {
  let upper = '';
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = ch.charCodeAt(0);
    // 只接受 ASCII 的 A–Z/a–z 与 2–7（不能依赖 `ch.toUpperCase() in DECODE_TABLE`：
    // 个别 Unicode 字符如 U+017F 长 s 会被 toUpperCase 折叠成 ASCII 字母而被静默错解）。
    const isAlphabetChar =
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x32 && code <= 0x37);   // 2-7
    if (!isAlphabetChar) throw new Error(`invalid base32 character: ${ch}`);
    upper += ch.toUpperCase();
  }
  return upper;
}

export function encodeBase32UpperCaseNoPadding(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let out = '';
  for (let i = 0; i < bytes.length; i += 5) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const b3 = bytes[i + 3] ?? 0;
    const b4 = bytes[i + 4] ?? 0;
    // 5 bytes → 40 bits via BigInt
    const buf = (BigInt(b0) << 32n) | (BigInt(b1) << 24n) | (BigInt(b2) << 16n) | (BigInt(b3) << 8n) | BigInt(b4);
    const remaining = bytes.length - i;
    out += ALPHABET[Number((buf >> 35n) & 0x1fn)];
    out += ALPHABET[Number((buf >> 30n) & 0x1fn)];
    if (remaining >= 2) out += ALPHABET[Number((buf >> 25n) & 0x1fn)];
    if (remaining >= 2) out += ALPHABET[Number((buf >> 20n) & 0x1fn)];
    if (remaining >= 3) out += ALPHABET[Number((buf >> 15n) & 0x1fn)];
    if (remaining >= 4) out += ALPHABET[Number((buf >> 10n) & 0x1fn)];
    if (remaining >= 4) out += ALPHABET[Number((buf >> 5n) & 0x1fn)];
    if (remaining >= 5) out += ALPHABET[Number(buf & 0x1fn)];
  }
  return out;
}
