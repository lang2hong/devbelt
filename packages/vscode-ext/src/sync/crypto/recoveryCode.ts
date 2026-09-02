import { randomBytes } from 'crypto';
import { hkdfSha256, SYNC_INFO } from './hkdf';
import { deriveEd25519KeyPair, type Ed25519KeyPair } from './ed25519';

/**
 * 一次性恢复码（§7.1）。
 *
 * 恢复码（256-bit CSPRNG = 32B）只在 init / recover 时一次性展示给用户，**不落盘**。
 * 由它派生出 recoverSign 密钥对与 KEK_recovery；recover 时用户重新输入恢复码即时派生。
 * base64url 编解码集中于此（供 keyStore 等处复用，公私材料一律用本编解码、不另起实现）。
 */

export const RECOVERY_CODE_BYTES = 32;
export const RECOVERY_KDF_SALT_BYTES = 16;
export const RECOVERY_KDF_OUTPUT_BYTES = 32;

export interface RecoveryKdfParams {
  alg: 'hkdf-sha256';
  version: 1;
  salt: Uint8Array;
  outputBytes: 32;
}

/** 生成 32B 恢复码及其 Base64Url（无 padding）展示串。 */
export function generateRecoveryCode(): { code: string; raw: Uint8Array } {
  const raw = new Uint8Array(randomBytes(RECOVERY_CODE_BYTES));
  return { code: encodeBase64Url(raw), raw };
}

/** raw bytes → Base64Url 无 padding。 */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64Url（可带 padding）→ raw bytes；非法字符抛错（fail-closed）。 */
export function decodeBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) {
    throw new Error(`invalid base64url string: ${s}`);
  }
  return new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

/** 恢复码分组展示（默认每 4 字符一组，便于抄写）。 */
export function formatRecoveryCode(code: string, groupSize = 4): string {
  const groups = code.match(new RegExp(`.{1,${groupSize}}`, 'g'));
  return groups ? groups.join(' ') : '';
}

export function assertRecoveryKdfParams(p: RecoveryKdfParams): void {
  if (p.alg !== 'hkdf-sha256') throw new Error(`unsupported recovery KDF alg: ${String(p.alg)}`);
  if (p.version !== 1) throw new Error(`unsupported recovery KDF version: ${String(p.version)}`);
  if (p.salt.length !== RECOVERY_KDF_SALT_BYTES) {
    throw new Error(`recovery KDF salt must be ${RECOVERY_KDF_SALT_BYTES} bytes, got ${p.salt.length}`);
  }
  if (p.outputBytes !== RECOVERY_KDF_OUTPUT_BYTES) {
    throw new Error(`recovery KDF output must be ${RECOVERY_KDF_OUTPUT_BYTES} bytes, got ${String(p.outputBytes)}`);
  }
}

function assertRecoveryCode(recoveryCode: Uint8Array): void {
  if (recoveryCode.length !== RECOVERY_CODE_BYTES) {
    throw new Error(`recovery code must be ${RECOVERY_CODE_BYTES} bytes, got ${recoveryCode.length}`);
  }
}

/** KEK_recovery（32B）= HKDF(ikm=恢复码, salt=recoveryKdf.salt, info=kek/recovery)。恢复码须 32B。 */
export function deriveKekRecovery(recoveryCode: Uint8Array, params: RecoveryKdfParams): Uint8Array {
  assertRecoveryCode(recoveryCode);
  assertRecoveryKdfParams(params);
  return hkdfSha256(recoveryCode, params.salt, SYNC_INFO.kekRecovery, RECOVERY_KDF_OUTPUT_BYTES);
}

/** recoverSign 密钥对 = Ed25519(HKDF(恢复码, 空 salt, info=recover-signing))。恢复码须 32B。 */
export function deriveRecoverSignKeyPair(recoveryCode: Uint8Array): Ed25519KeyPair {
  assertRecoveryCode(recoveryCode);
  const seed = hkdfSha256(recoveryCode, new Uint8Array(0), SYNC_INFO.recoverSigning);
  return deriveEd25519KeyPair(seed);
}