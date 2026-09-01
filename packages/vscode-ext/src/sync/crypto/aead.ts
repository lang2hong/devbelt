import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * AES-256-GCM 加解密原语（§8.1.2：nonce 12B、tag 16B 显式字段）。
 *
 * 显式 key + nonce，不做密钥派生（派生归 hkdf / argon2）。nonce 复用防护不在本层：
 * 由 B3 状态机 + 服务端 `personal_sync_nonces` ledger 负责。
 * 使用宿主 Node `crypto`，不引入第三方 AES/CSPRNG 包。
 */

export const AES_KEY_BYTES = 32;
export const AES_NONCE_BYTES = 12;
export const AES_TAG_BYTES = 16;

/** 生成 12B 随机 nonce。 */
export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(AES_NONCE_BYTES));
}

export interface SealedBox {
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

/** AES-256-GCM 加密。aad 可选（record/envelope AAD 由调用方在 B2 规范化后传入）。 */
export function sealAes256Gcm(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): SealedBox {
  assertKey(key);
  if (nonce.length !== AES_NONCE_BYTES) throw new Error(`GCM nonce must be ${AES_NONCE_BYTES} bytes, got ${nonce.length}`);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AES_TAG_BYTES });
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: new Uint8Array(ciphertext), tag: new Uint8Array(cipher.getAuthTag()) };
}

/** AES-256-GCM 解密；tag/密文被篡改或 key 不对时抛错。 */
export function openAes256Gcm(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  assertKey(key);
  if (nonce.length !== AES_NONCE_BYTES) throw new Error(`GCM nonce must be ${AES_NONCE_BYTES} bytes, got ${nonce.length}`);
  if (tag.length !== AES_TAG_BYTES) throw new Error(`GCM tag must be ${AES_TAG_BYTES} bytes, got ${tag.length}`);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: AES_TAG_BYTES });
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

function assertKey(key: Uint8Array): void {
  if (key.length !== AES_KEY_BYTES) throw new Error(`AES-256 key must be ${AES_KEY_BYTES} bytes, got ${key.length}`);
}