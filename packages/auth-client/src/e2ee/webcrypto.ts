/**
 * 浏览器 E2EE 原语（P6-S5b）：基于 WebCrypto，**不使用 node:crypto**。
 * 与 db-host 的 Node 实现逐字节对齐（HKDF info / AES-GCM nonce+ciphertext+tag / AAD=JCS）。
 */
const TE = new TextEncoder();

/** 取底层 ArrayBuffer 视图（满足 WebCrypto 的 BufferSource 类型）。 */
function toBuf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** base64url（无 padding）→字节。 */
export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** HKDF-SHA-256（WebCrypto）。 */
export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toBuf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: toBuf(salt), info: toBuf(TE.encode(info)) }, key, length * 8,
  );
  return new Uint8Array(bits);
}

/** AES-256-GCM 解密：WebCrypto 需要 `ciphertext || tag` 拼接 + tagLength=128。 */
export async function aesGcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', toBuf(key), 'AES-GCM', false, ['decrypt']);
  const ct = new Uint8Array(ciphertext.length + tag.length);
  ct.set(ciphertext);
  ct.set(tag, ciphertext.length);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuf(nonce), tagLength: 128, additionalData: toBuf(aad) }, k, toBuf(ct),
  );
  return new Uint8Array(pt);
}
