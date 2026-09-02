import { createPublicKey, createHash, verify as cryptoVerify, type KeyObject } from 'crypto';
import { ValidationError } from '../domain/errors.js';

/**
 * 个人 E2E 同步的验签 / digest / JCS（§7.4）。
 *
 * 服务端只验签、只校验协议元数据与 KDF 参数范围；不派生任何密钥、不持有明文。
 * - 签名 Ed25519（RFC8032），公钥为服务端存 `personal_sync_state.sign_pub`（32B raw）。
 * - requestDigest = SHA-256(JCS(body 除 signature))，base64url 无 padding。
 * - JCS 采用 RFC 8785 的排序键 + 标准 JSON 转义；本 DTO 仅含整数/字符串/布尔/null，
 *   无浮点 / ±0 / 非有限数，故与 RFC 8785 逐字节一致。
 */

/** Ed25519 SPKI DER 前缀（RFC 8410：`302a300506032b6570032100` + 32B raw pub）。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** 从 32B raw Ed25519 公钥构造 KeyObject。 */
export function ed25519PublicFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new ValidationError(`invalid Ed25519 public key length ${raw.length}`);
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** 校验 Ed25519 签名（message 为 UTF-8 签到字节）。 */
export function verifyEd25519(rawPub: Buffer, message: Buffer, signature: Buffer): boolean {
  try {
    return cryptoVerify(null, message, ed25519PublicFromRaw(rawPub), signature);
  } catch {
    return false;
  }
}

/** RFC 8785 风格的 JCS 规范化（排序键 + JSON 转义）。 */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('non-finite number in signing input');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  throw new ValidationError(`unsupported type in signing input: ${t}`);
}

/** SHA-256（返回 raw Buffer）。 */
export function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** requestDigest = SHA-256(JCS(body 除 signature))，base64url 无 padding。 */
export function requestDigestOf(bodyWithoutSignature: unknown): string {
  return sha256(Buffer.from(jcs(bodyWithoutSignature), 'utf8')).toString('base64url');
}

/** base64url 无 padding 解码，按期望字节长度校验（不符抛 ValidationError）。 */
export function decodeB64Url(s: string, expectedLength: number, field: string): Buffer {
  if (typeof s !== 'string' || s.length === 0) throw new ValidationError(`${field} is not base64url`);
  let buf: Buffer;
  try {
    buf = Buffer.from(s, 'base64url');
  } catch {
    throw new ValidationError(`${field} is not valid base64url`);
  }
  if (buf.length !== expectedLength) {
    throw new ValidationError(`${field} must decode to ${expectedLength} bytes (got ${buf.length})`);
  }
  return buf;
}