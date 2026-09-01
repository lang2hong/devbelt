import { randomBytes } from 'crypto';
import type { SecretStorage } from 'vscode';
import { hkdfSha256, SYNC_INFO } from './hkdf';
import { deriveEd25519KeyPair, type Ed25519KeyPair } from './ed25519';

/**
 * DEK 生成与落盘（§8.1.2 + §8.1.6 裁定）。
 *
 * DEK 是随 keyEpoch 轮换的 32B CSPRNG，是客户端唯一需要持久化的对称密钥根。
 * 落盘介质仅 SecretStorage（OS 钥匙串加密），**绝不写 globalState**。
 * syncSign 私钥由 DEK 确定性派生、不单独落盘。
 */

export const DEK_BYTES = 32;

/** 生成新的 32B DEK。 */
export function generateDek(): Uint8Array {
  return new Uint8Array(randomBytes(DEK_BYTES));
}

/** syncSign 密钥对 = Ed25519(HKDF(DEK, 空 salt, info=signing))。 */
export function deriveSyncSignKeyPair(dek: Uint8Array): Ed25519KeyPair {
  const seed = hkdfSha256(dek, new Uint8Array(0), SYNC_INFO.signing);
  return deriveEd25519KeyPair(seed);
}

/** DEK 的 SecretStorage 存取（本地 base64，非 DTO 传输格式）。 */
export class DekStore {
  private static readonly KEY = 'dbclient.sync.dek';

  constructor(private readonly secrets: SecretStorage) {}

  async store(dek: Uint8Array): Promise<void> {
    if (dek.length !== DEK_BYTES) throw new Error(`DEK must be ${DEK_BYTES} bytes, got ${dek.length}`);
    await this.secrets.store(DekStore.KEY, Buffer.from(dek).toString('base64'));
  }

  async get(): Promise<Uint8Array | undefined> {
    const stored = await this.secrets.get(DekStore.KEY);
    if (stored === undefined) return undefined;
    const dek = new Uint8Array(Buffer.from(stored, 'base64'));
    if (dek.length !== DEK_BYTES) throw new Error(`corrupt DEK: expected ${DEK_BYTES} bytes, got ${dek.length}`);
    return dek;
  }

  async clear(): Promise<void> {
    await this.secrets.delete(DekStore.KEY);
  }
}