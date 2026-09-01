import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Ed25519 派生与签名（§8.1.2）。
 *
 * §8.1.2 的 `syncSignPriv` / `recoverSignPriv` 是「32B 确定性 seed」（经 HKDF 派生），
 * 按 RFC8032 展开公私钥对。宿主 Node crypto 仅有「随机 keygen + 验签」，无
 * 「32B seed → keypair」的 RFC8032 原语，故用 @noble/curves（精确版本、纯 JS、可审计）。
 * 这里只依赖 32B seed，不做随机 keygen。
 */

export const ED25519_SEED_BYTES = 32;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

export interface Ed25519KeyPair {
  /** 32B raw 公钥（经 B2 上传服务端 sign_pub / recover_sign_pub） */
  publicKey: Uint8Array;
  /** 32B seed（永不落盘，必要时由 DEK / 恢复码即时派生） */
  seed: Uint8Array;
}

function assertSeed(seed: Uint8Array): void {
  if (seed.length !== ED25519_SEED_BYTES) {
    throw new Error(`Ed25519 seed must be ${ED25519_SEED_BYTES} bytes, got ${seed.length}`);
  }
}

/** 由 32B seed 派生公私钥对。 */
export function deriveEd25519KeyPair(seed: Uint8Array): Ed25519KeyPair {
  assertSeed(seed);
  return { publicKey: ed25519.getPublicKey(seed), seed };
}

/** 用 32B seed 对 message 签名，返回 64B signature。 */
export function signEd25519(message: Uint8Array, seed: Uint8Array): Uint8Array {
  assertSeed(seed);
  return ed25519.sign(message, seed);
}

/** 校验签名（客户端自检/测试用；服务端自带验签，不依赖此函数）。 */
export function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  return ed25519.verify(signature, message, publicKey);
}