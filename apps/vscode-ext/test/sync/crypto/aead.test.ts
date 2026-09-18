import { describe, expect, it } from 'vitest';
import {
  AES_NONCE_BYTES,
  AES_TAG_BYTES,
  openAes256Gcm,
  randomNonce,
  sealAes256Gcm,
} from '@devkit/db-host/sync/crypto/aead';

const key = new Uint8Array(32).fill(1);
const nonce = new Uint8Array(12).fill(2);

describe('aead', () => {
  it('roundtrip', () => {
    const pt = new TextEncoder().encode('secret payload');
    const box = sealAes256Gcm(key, nonce, pt);
    expect(box.tag.length).toBe(AES_TAG_BYTES);
    expect(new TextDecoder().decode(openAes256Gcm(key, nonce, box.ciphertext, box.tag))).toBe('secret payload');
  });

  it('AAD 参与认证：错误 AAD 解密失败', () => {
    const pt = new Uint8Array([1, 2, 3]);
    const box = sealAes256Gcm(key, nonce, pt, new TextEncoder().encode('aad'));
    expect(() => openAes256Gcm(key, nonce, box.ciphertext, box.tag, new TextEncoder().encode('wrong'))).toThrow();
  });

  it('篡改密文解密失败', () => {
    const box = sealAes256Gcm(key, nonce, new Uint8Array([1, 2, 3]));
    box.ciphertext[0] ^= 0xff;
    expect(() => openAes256Gcm(key, nonce, box.ciphertext, box.tag)).toThrow();
  });

  it('错误 tag 长度拒绝', () => {
    const box = sealAes256Gcm(key, nonce, new Uint8Array([1, 2, 3]));
    expect(() => openAes256Gcm(key, nonce, box.ciphertext, new Uint8Array(12))).toThrowError(/16 bytes/);
  });

  it('错误 nonce 长度拒绝', () => {
    expect(() => sealAes256Gcm(key, new Uint8Array(11), new Uint8Array(1))).toThrowError(/12 bytes/);
  });

  it('randomNonce 长度 12B', () => {
    expect(randomNonce().length).toBe(AES_NONCE_BYTES);
  });
});