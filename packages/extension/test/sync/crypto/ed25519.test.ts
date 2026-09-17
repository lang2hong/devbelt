import { describe, expect, it } from 'vitest';
import {
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SEED_BYTES,
  ED25519_SIGNATURE_BYTES,
  deriveEd25519KeyPair,
  signEd25519,
  verifyEd25519,
} from '../../../src/sync/crypto/ed25519';

const SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUB_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

function hx(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'));
}

describe('ed25519', () => {
  it('RFC8032 向量：32B seed → 公钥', () => {
    const kp = deriveEd25519KeyPair(hx(SEED_HEX));
    expect(Buffer.from(kp.publicKey).toString('hex')).toBe(PUB_HEX);
    expect(kp.seed.length).toBe(ED25519_SEED_BYTES);
    expect(kp.publicKey.length).toBe(ED25519_PUBLIC_KEY_BYTES);
  });

  it('sign → verify roundtrip', () => {
    const seed = hx(SEED_HEX);
    const kp = deriveEd25519KeyPair(seed);
    const msg = new TextEncoder().encode('hello dbclient sync');
    const sig = signEd25519(msg, seed);
    expect(sig.length).toBe(ED25519_SIGNATURE_BYTES);
    expect(verifyEd25519(sig, msg, kp.publicKey)).toBe(true);
  });

  it('签名不接受被篡改消息', () => {
    const seed = hx(SEED_HEX);
    const kp = deriveEd25519KeyPair(seed);
    const sig = signEd25519(new TextEncoder().encode('a'), seed);
    expect(verifyEd25519(sig, new TextEncoder().encode('b'), kp.publicKey)).toBe(false);
  });

  it('seed 长度错误抛错', () => {
    expect(() => deriveEd25519KeyPair(new Uint8Array(31))).toThrowError(/32 bytes/);
    expect(() => signEd25519(new Uint8Array(1), new Uint8Array(33))).toThrowError(/32 bytes/);
  });
});