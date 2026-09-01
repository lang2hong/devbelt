import { decodeBase64Url } from '../crypto/recoveryCode';

/**
 * 个人同步 V3 协议 DTO 类型与编码校验（§8.1.7）。
 *
 * u64（keyEpoch/stateVersion/baseVersion/envelopeVersion/after/snapshotSequence）
 * 一律十进制字符串、无符号、无前导零；0 仅在该字段协议允许时接受。base64url
 * 值严格解码并校验规格长度。待签名 body 不得混入 undefined/函数/bigint/任意对象。
 */

export interface SmpKdfDto {
  alg: 'argon2id';
  version: 1;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: string;
  outputBytes: 32;
}

export interface RecoveryKdfDto {
  alg: 'hkdf-sha256';
  version: 1;
  salt: string;
  outputBytes: 32;
}

export interface EnvelopeDto {
  protocolVersion: 1;
  cipherSuite: 'AES-256-GCM';
  formatVersion: 1;
  envelopeVersion: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface NewStateDto {
  protocolVersion: 1;
  cipherSuite: 'AES-256-GCM';
  formatVersion: 1;
  smpKdf: SmpKdfDto;
  recoveryKdf: RecoveryKdfDto;
  envelopeSmp: EnvelopeDto;
  envelopeRecovery: EnvelopeDto;
  signPub: string;
  recoverSignPub: string;
}

export interface SignedMutationBase {
  protocolVersion: 1;
  keyEpoch: string;
  mutationId: string;
}

/** u64 十进制字符串：无符号，无前导零；0 仅在 allowZero 时接受。 */
export function assertU64Decimal(s: string, field: string, allowZero = false): void {
  if (allowZero && s === '0') return;
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error(`${field} must be an unsigned decimal integer with no leading zeros`);
  }
}

/** base64url 严格解码并校验长度。 */
export function assertB64UrlLen(s: string, lenBytes: number, field: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(s);
  } catch (err) {
    throw new Error(`${field} is not valid base64url: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (bytes.length !== lenBytes) {
    throw new Error(`${field} must decode to ${lenBytes} bytes (got ${bytes.length})`);
  }
  return bytes;
}