import { hkdfSync } from 'crypto';

/**
 * HKDF-SHA-256 派生原语（§8.1.2）。
 *
 * 所有派生 info 字符串由本节集中定义，避免散落魔法字符串。
 * 宿主 Node `crypto.hkdfSync` 承担派生，不引入第三方 HKDF 包。
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

/** envelope purpose 值域（§8.1.2 冻结） */
export type EnvelopePurpose = 'smp' | 'recovery';

/**
 * envelope 每版专用 AEAD 派生的 info（§8.1.2）。
 *
 * keyEpoch / envelopeVersion 一律十进制无前导零（内部 BigInt.toString(10)），
 * 杜绝 `"01"` / `"1.0"` 等多义表示。
 */
export function envelopeInfo(keyEpoch: bigint, purpose: EnvelopePurpose, envelopeVersion: bigint): string {
  if (keyEpoch < 1n) throw new Error(`keyEpoch must be >= 1, got ${keyEpoch}`);
  if (envelopeVersion < 1n) throw new Error(`envelopeVersion must be >= 1, got ${envelopeVersion}`);
  return `dbclient/sync/v1/envelope/${keyEpoch.toString(10)}/${purpose}/${envelopeVersion.toString(10)}`;
}

/** HKDF-SHA-256，返回指定长度字节。salt 传空（0 长）表示「空 salt」。 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length = 32,
): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length));
}