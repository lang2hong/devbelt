import { randomBytes } from 'crypto';
import type { SecureStorageLike } from '../../hostTypes.js';
import { hkdfSha256, SYNC_INFO } from './hkdf.js';
import { deriveEd25519KeyPair, type Ed25519KeyPair } from './ed25519.js';
import { decodeBase64Url, encodeBase64Url } from './recoveryCode.js';

/**
 * DEK 生成与落盘（§7.1）。
 *
 * DEK 是随 keyEpoch 轮换的 32B CSPRNG，是客户端唯一需要持久化的对称密钥根。
 * 落盘介质仅 SecureStorageLike，key 按账户 + epoch 隔离：`devbelt.sync.dek.<userId>.<keyEpoch>`。
 * 本模块**只提供 load/store/delete 原语**；换钥、旧 epoch 清理、远端状态提交后的
 * 编排层负责跨存储原子性。logout 不删 DEK；destroy / reset-after-loss 成功后删除旧 epoch DEK。
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

/** DEK 的 SecureStorageLike 存取（account + epoch 隔离）。 */
export class DekStore {
  private static readonly KEY_PREFIX = 'devbelt.sync.dek';

  constructor(private readonly secrets: SecureStorageLike) {}

  private keyFor(userId: string, keyEpoch: bigint): string {
    return `${DekStore.KEY_PREFIX}.${userId}.${keyEpoch.toString(10)}`;
  }

  /** 读取 DEK；无值返回 undefined；有值但损坏（非法 base64url / 非 32B）fail-closed 抛错。 */
  async load(userId: string, keyEpoch: bigint): Promise<Uint8Array | undefined> {
    const stored = await this.secrets.get(this.keyFor(userId, keyEpoch));
    if (stored === undefined) return undefined;
    let dek: Uint8Array;
    try {
      dek = decodeBase64Url(stored);
    } catch (err) {
      throw new Error(`corrupt DEK: ${err instanceof Error ? err.message : 'invalid base64url'}`);
    }
    if (dek.length !== DEK_BYTES) {
      throw new Error(`corrupt DEK: expected ${DEK_BYTES} bytes, got ${dek.length}`);
    }
    return dek;
  }

  async store(userId: string, keyEpoch: bigint, dek: Uint8Array): Promise<void> {
    if (dek.length !== DEK_BYTES) throw new Error(`DEK must be ${DEK_BYTES} bytes, got ${dek.length}`);
    await this.secrets.store(this.keyFor(userId, keyEpoch), encodeBase64Url(dek));
  }

  async delete(userId: string, keyEpoch: bigint): Promise<void> {
    await this.secrets.delete(this.keyFor(userId, keyEpoch));
  }
}
