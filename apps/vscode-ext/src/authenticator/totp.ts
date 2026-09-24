/**
 * TOTP/HOTP 纯函数（仅用 node:crypto 的 HMAC；编码/URI 已下沉 db-host 共用）。
 *
 * - RFC 4226 HOTP：HMAC(secret, 8-byte big-endian counter) → dynamic truncation → mod 10^digits。
 * - RFC 6238 TOTP：counter = floor((nowMs/1000)/period)，T0=0；返回 { code, secondsLeft }。
 * - base32/canonical/otpauth 为宿主无关纯函数（db-host），此处仅 HMAC 与计数器。
 *
 * 注意：seed 字节长度与算法匹配——RFC 6238 向量 SHA1=20B/SHA256=32B/SHA512=64B。
 */
import { createHmac } from 'node:crypto';
import { decodeBase32Loose } from '@devbelt/db-host/authenticator/base32';
import type { TotpAlgorithm } from '@devbelt/db-host/authenticator/types';

export { decodeBase32Loose, encodeBase32UpperCaseNoPadding } from '@devbelt/db-host/authenticator/base32';
export { canonicalizeSecret, stripZeroWidth } from '@devbelt/db-host/authenticator/canonical';

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

/** HOTP（RFC 4226）：给定字节 secret、counter、位数、算法返回定长 code 字符串（左补 0）。 */
export function hotp(secretBytes: Uint8Array, counter: bigint, digits: 6 | 8, algorithm: TotpAlgorithm = 'SHA1'): string {
  const mac = createHmac(algorithmName(algorithm), Buffer.from(secretBytes)).update(hotpCounter(counter)).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binCode = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  const mod = digits === 8 ? 100_000_000 : 1_000_000;
  return String(binCode % mod).padStart(digits, '0');
}

export function totp(secretBytes: Uint8Array, nowMs: number, period: 30 | 60 = 30, digits: 6 | 8 = 6, algorithm: TotpAlgorithm = 'SHA1'): { code: string; secondsLeft: number } {
  const counter = BigInt(Math.floor(nowMs / 1000 / period));
  const code = hotp(secretBytes, counter, digits, algorithm);
  const elapsed = Math.floor(nowMs / 1000) % period;
  return { code, secondsLeft: period - elapsed };
}

/** 从规范化 base32 secret 直接算 TOTP（secretCache 存的就是规范化形态）。 */
export function totpFromSecret(normSecret: string, nowMs: number, period: 30 | 60 = 30, digits: 6 | 8 = 6, algorithm: TotpAlgorithm = 'SHA1'): { code: string; secondsLeft: number } {
  return totp(decodeBase32Loose(normSecret), nowMs, period, digits, algorithm);
}
