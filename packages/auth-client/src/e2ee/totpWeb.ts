import { decodeBase32Loose } from '@devbelt/db-host/authenticator/base32';

/**
 * 浏览器 TOTP（P6-S5c）：WebCrypto HMAC，SHA1/256/512，与扩展 Node 实现语义一致。
 * 仅用于 Web 展示出码；secret 规范化/base32 解析复用 db-host 纯函数。
 */
export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';
const HASH: Record<TotpAlgorithm, 'SHA-1' | 'SHA-256' | 'SHA-512'> = {
  SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512',
};

function toBuf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export async function totpWeb(
  secretBase32: string,
  nowMs: number,
  period: 30 | 60 = 30,
  digits: 6 | 8 = 6,
  algorithm: TotpAlgorithm = 'SHA1',
): Promise<{ code: string; secondsLeft: number }> {
  const counter = BigInt(Math.floor(nowMs / 1000 / period));
  const keyBytes = decodeBase32Loose(secretBase32);
  const key = await crypto.subtle.importKey('raw', toBuf(keyBytes), { name: 'HMAC', hash: HASH[algorithm] }, false, ['sign']);
  const counterBuf = new ArrayBuffer(8);
  new DataView(counterBuf).setBigUint64(0, counter);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  const mod = digits === 8 ? 100_000_000 : 1_000_000;
  const code = String(bin % mod).padStart(digits, '0');
  const elapsed = Math.floor(nowMs / 1000) % period;
  return { code, secondsLeft: period - elapsed };
}
