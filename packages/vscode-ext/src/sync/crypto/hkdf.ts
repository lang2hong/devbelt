import { hkdfSync } from 'crypto';

/**
 * HKDF-SHA-256 派生原语（§8.1.2）。
 *
 * 所有派生 info 字符串由本节集中定义，避免散落魔法字符串。
 */

/** §8.1.2 中三个固定 info（UTF-8）。 */
export const SYNC_INFO = {
  /** syncSignPriv 派生 */
  signing: 'dbclient/sync/v1/signing',
  /** recoverSignPriv 派生 */
  recoverSigning: 'dbclient/sync/v1/recover-signing',
  /** KEK_recovery 派生 */
  kekRecovery: 'dbclient/sync/v1/kek/recovery',
} as const;

/** envelope 每版专用 AEAD 派的 info 模板（§8.1.2）。 */
export function envelopeInfo(keyEpoch: string, purpose: string, envelopeVersion: string): string {
  return `dbclient/sync/v1/envelope/${keyEpoch}/${purpose}/${envelopeVersion}`;
}

/** HKDF-SHA-256，返回指定长度字节。salt 传空（0 长）时表示「空 salt」。 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length = 32,
): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length));
}