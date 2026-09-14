import type { Queryable } from '../repository/mysql/db.js';
import type { ISyncMutationRepo } from '../repository/interfaces.js';
import type { PersonalSyncState } from '../domain/entities.js';
import type { SyncAction } from '../domain/enums.js';
import { ConflictError, SyncEpochStaleError, SyncSignatureInvalidError, ValidationError } from '../domain/errors.js';
import { parseU64 } from '../domain/syncU64.js';
import { jcs, verifyEd25519, decodeB64Url } from './syncCrypto.js';

export const SYNC_DOMAIN = 'dbclient/sync/v1';

/** u64 输入字段经 parseU64 校验（拒前导零/越界），非法→400 VALIDATION_FAILED。 */
export function assertU64(value: string, field: string): void {
  try {
    parseU64(value);
  } catch {
    throw new ValidationError(`${field} is not a valid u64`);
  }
}

/** 请求 keyEpoch 必须等于 active state keyEpoch，否则 409 SYNC_EPOCH_STALE。 */
export function assertEpoch(state: PersonalSyncState, keyEpoch: string): void {
  if (state.keyEpoch !== keyEpoch) throw new SyncEpochStaleError(state.keyEpoch);
}

/** 校验 Ed25519 签名（signingInput 为已被 JCS 规范化的字节来源）。 */
export function verifySignature(rawPub: Buffer, signingInput: Record<string, unknown>, signature: Buffer): void {
  const message = Buffer.from(jcs(signingInput), 'utf8');
  if (!verifyEd25519(rawPub, message, signature)) throw new SyncSignatureInvalidError();
}

/**
 * envelope 重写时的 (KDF salt, GCM nonce) 新鲜度校验。
 *
 * 为什么必须有：envelope 的 AES-256-GCM 密钥由「口令 + KDF salt」派生。若客户端
 * 提交与已存**相同的 salt**，同一口令会得到**同一把 KEK**；再叠加**相同的 nonce**，
 * 就是 GCM 下的密钥流复用。而 envelope 的 ct 固定 32 字节（恰好两个 AES 块内），
 * 攻击者拿到新旧两条密文即可异或得到两把主密钥的 XOR；单块消息还能直接反解出
 * GHASH 的 H，从而伪造 tag。
 *
 * 只要 salt 或 nonce 任一变化即安全（KEK 变或密钥流变）。此处要求**两者都不得
 * 与已存值相同**，比理论下限更严一点，代价仅是客户端必须两者都重新随机 ——
 * 这本就是正确实现的行为，且能挡住「只换其一」的实现疏漏。
 */
export function assertEnvelopeFreshness(
  prev: { salt: Buffer; nonce: Buffer },
  next: { salt: Buffer; nonce: Buffer },
  label: string,
): void {
  if (prev.salt.equals(next.salt)) {
    throw new ValidationError(`${label} KDF salt must be freshly generated (reusing it repeats the AES-GCM keystream)`);
  }
  if (prev.nonce.equals(next.nonce)) {
    throw new ValidationError(`${label} envelope nonce must be freshly generated (reusing it repeats the AES-GCM keystream)`);
  }
}

/** receipt 幂等：同 id 同 digest → 返回已存结果；同 id 异 digest → 409；未命中或已过期 → undefined。 */
export async function checkReceipt(
  tx: Queryable,
  mutationRepo: ISyncMutationRepo,
  userId: number,
  keyEpoch: string,
  mutationId: string,
  requestDigest: string,
): Promise<{ resultVersion: string | null; resultChangeSequence: string | null; resultRecoveryCodeSetTime: Date | null } | undefined> {
  const mid = decodeB64Url(mutationId, 16, 'mutationId');
  const digest = decodeB64Url(requestDigest, 32, 'requestDigest');
  const existing = await mutationRepo.findByMutationId(tx, userId, keyEpoch, mid);
  if (!existing) return undefined;
  // 24h 仅为保留期；过期即按无 receipt 走正常 epoch/签名/版本校验（§7.4）。
  if (existing.expiresTime <= new Date()) return undefined;
  if (existing.requestDigest.equals(digest)) {
    return { resultVersion: existing.resultVersion, resultChangeSequence: existing.resultChangeSequence, resultRecoveryCodeSetTime: existing.resultRecoveryCodeSetTime };
  }
  throw new ConflictError('mutation id reused with different digest');
}

/** 落一条已应用 mutation 的 receipt（幂等回放用）。 */
export async function recordReceipt(
  tx: Queryable,
  mutationRepo: ISyncMutationRepo,
  userId: number,
  keyEpoch: string,
  mutationId: string,
  requestDigest: string,
  action: SyncAction,
  resultVersion: string | null,
  resultChangeSequence: string | null,
  resultRecoveryCodeSetTime: Date | null = null,
): Promise<void> {
  await mutationRepo.record(tx, {
    userId, keyEpoch,
    mutationId: decodeB64Url(mutationId, 16, 'mutationId'),
    requestDigest: decodeB64Url(requestDigest, 32, 'requestDigest'),
    action,
    resultVersion,
    resultChangeSequence,
    resultRecoveryCodeSetTime,
    status: 'applied',
    expiresTime: new Date(Date.now() + 24 * 3600 * 1000),
  });
}