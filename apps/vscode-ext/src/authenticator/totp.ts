/**
 * TOTP/HOTP 纯函数（零第三方依赖，仅用 node:crypto，不 import vscode，未来可抽到共享包）。
 *
 * - RFC 4226 HOTP：HMAC(secret, 8-byte big-endian counter) → dynamic truncation → mod 10^digits。
 * - RFC 6238 TOTP：counter = floor((nowMs/1000)/period)，T0=0；返回 { code, secondsLeft }。
 * - `canonicalizeSecret`：输入→去空白→decodeBase32Loose→encode 成大写无 padding 规范形态；
 *    所有入库/导出 secret 都必须经此归一化（addEntry、otpauth 解析入口均调用）。
 *
 * 注意：seed 字节长度与算法匹配——RFC 6238 向量
 *   SHA1=20B, SHA256=32B, SHA512=64B，测试向量必须分别用正确长度，否则向量不过。
 */

import { createHmac } from 'node:crypto';
import { decodeBase32Loose, encodeBase32UpperCaseNoPadding } from './base32.js';
import type { TotpAlgorithm } from './types.js';

export { decodeBase32Loose, encodeBase32UpperCaseNoPadding } from './base32.js';

/** 零宽字符（otpauth URI 解析入口先剥一次；canonicalize 里再剥普通 \s 兜底）。 */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;

/**
 * 归一化 secret：剥所有 JS `\s` 空白（含全角空格、粘贴带入零宽残留）→ base32 解码→
 * 重新编码为大写、无 padding 的规范形态。解码非法字符抛错。
 */
export function canonicalizeSecret(input: string): string {
  const stripped = input.replace(/\s+/g, '');
  const bytes = decodeBase32Loose(stripped);
  return encodeBase32UpperCaseNoPadding(bytes);
}

function algorithmName(a: TotpAlgorithm): 'sha1' | 'sha256' | 'sha512' {
  switch (a) {
    case 'SHA1': return 'sha1';
    case 'SHA256': return 'sha256';
    case 'SHA512': return 'sha512';
  }
}

/** HOTP counter 8-byte big-endian 编码。 */
function hotpCounter(counter: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  return buf;
}

/**
 * HOTP（RFC 4226）：给定字节 secret、counter、位数、算法返回定长 code 字符串（左补 0）。
 */
export function hotp(secretBytes: Uint8Array, counter: bigint, digits: 6 | 8, algorithm: TotpAlgorithm = 'SHA1'): string {
  const mac = createHmac(algorithmName(algorithm), Buffer.from(secretBytes)).update(hotpCounter(counter)).digest();
  // dynamic truncation：取最后字节低 4 位为 offset，取 4 字节（最高位清零避免符号），mod 10^digits
  const offset = mac[mac.length - 1] & 0x0f;
  const binCode = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  const mod = digits === 8 ? 100_000_000 : 1_000_000;
  const code = binCode % mod;
  return String(code).padStart(digits, '0');
}

export function totp(secretBytes: Uint8Array, nowMs: number, period: 30 | 60 = 30, digits: 6 | 8 = 6, algorithm: TotpAlgorithm = 'SHA1'): { code: string; secondsLeft: number } {
  const counter = BigInt(Math.floor(nowMs / 1000 / period));
  const code = hotp(secretBytes, counter, digits, algorithm);
  const elapsed = Math.floor(nowMs / 1000) % period;
  const secondsLeft = period - elapsed;
  return { code, secondsLeft };
}

/**
 * 从规范化（大写无 padding base32 字符串）secret 直接算 TOTP；
 * Store.getCodes 走此入口——secretCache 里存的就是规范化形态。
 */
export function totpFromSecret(normSecret: string, nowMs: number, period: 30 | 60 = 30, digits: 6 | 8 = 6, algorithm: TotpAlgorithm = 'SHA1'): { code: string; secondsLeft: number } {
  const bytes = decodeBase32Loose(normSecret);
  return totp(bytes, nowMs, period, digits, algorithm);
}

/** 剥掉零宽字符；otpauth URI 解析入口用。 */
export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH_RE, '');
}
