import { sealAes256Gcm, openAes256Gcm, randomNonce } from './crypto/aead';
import { hkdfSha256, envelopeInfo, type EnvelopePurpose } from './crypto/hkdf';
import { jcs } from './crypto/jcs';
import { encodeBase64Url, decodeBase64Url } from './crypto/recoveryCode';
import type { EnvelopeDto } from './e2e/types';

/**
 * 密钥 envelope（§7.1）：用 KEK_smp 或 KEK_recovery 包裹 DEK。
 *
 * - 信封自身是客户端内部结构，服务端只存 ciphertext/nonce/tag/envelopeVersion，从不打开。
 * - envelope 每版专用 AEAD key = HKDF-SHA-256(KEK, 空 salt, envelopeInfo(keyEpoch,purpose,envelopeVersion))。
 * - AAD 与 recordAad 同构：{ userId, keyEpoch, envelopeVersion, protocolVersion, cipherSuite,
 *   formatVersion, purpose }（purpose ∈ 'smp' | 'recovery'），规范化后作 AAD（JCS → UTF-8）。
 * - 非 pooled：每次 seal/open 即时派生 key，不缓存 KEK 派生结果。
 */

function aadBytes(userId: string, keyEpoch: string, envelopeVersion: string, purpose: EnvelopePurpose): Uint8Array {
  const aad = {
    userId,
    keyEpoch,
    envelopeVersion,
    protocolVersion: 1,
    cipherSuite: 'AES-256-GCM',
    formatVersion: 1,
    purpose,
  };
  return new Uint8Array(Buffer.from(jcs(aad), 'utf8'));
}

export function sealEnvelope(
  kek: Uint8Array,
  dek: Uint8Array,
  userId: string,
  keyEpoch: string,
  purpose: EnvelopePurpose,
  envelopeVersion = '1',
): EnvelopeDto {
  const nonce = randomNonce();
  const key = hkdfSha256(kek, new Uint8Array(0), envelopeInfo(BigInt(keyEpoch), purpose, BigInt(envelopeVersion)), 32);
  const box = sealAes256Gcm(key, nonce, dek, aadBytes(userId, keyEpoch, envelopeVersion, purpose));
  return {
    protocolVersion: 1,
    cipherSuite: 'AES-256-GCM',
    formatVersion: 1,
    envelopeVersion,
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(box.ciphertext),
    tag: encodeBase64Url(box.tag),
  };
}

export function openEnvelope(
  kek: Uint8Array,
  envelope: EnvelopeDto,
  userId: string,
  keyEpoch: string,
  purpose: EnvelopePurpose,
): Uint8Array {
  const key = hkdfSha256(kek, new Uint8Array(0), envelopeInfo(BigInt(keyEpoch), purpose, BigInt(envelope.envelopeVersion)), 32);
  return openAes256Gcm(
    key,
    decodeBase64Url(envelope.nonce),
    decodeBase64Url(envelope.ciphertext),
    decodeBase64Url(envelope.tag),
    aadBytes(userId, keyEpoch, envelope.envelopeVersion, purpose),
  );
}