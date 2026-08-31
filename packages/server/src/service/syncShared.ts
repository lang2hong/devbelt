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

/** receipt 幂等：同 id 同 digest → 返回已存结果；同 id 异 digest → 409；未命中或已过期 → undefined。 */
export async function checkReceipt(
  tx: Queryable,
  mutationRepo: ISyncMutationRepo,
  userId: number,
  keyEpoch: string,
  mutationId: string,
  requestDigest: string,
): Promise<{ resultVersion: string | null; resultChangeSequence: string | null } | undefined> {
  const mid = decodeB64Url(mutationId, 16, 'mutationId');
  const digest = decodeB64Url(requestDigest, 32, 'requestDigest');
  const existing = await mutationRepo.findByMutationId(tx, userId, keyEpoch, mid);
  if (!existing) return undefined;
  // 24h 仅为保留期；过期即按无 receipt 走正常 epoch/签名/版本校验（§8.1.8）。
  if (existing.expiresTime <= new Date()) return undefined;
  if (existing.requestDigest.equals(digest)) {
    return { resultVersion: existing.resultVersion, resultChangeSequence: existing.resultChangeSequence };
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
): Promise<void> {
  await mutationRepo.record(tx, {
    userId, keyEpoch,
    mutationId: decodeB64Url(mutationId, 16, 'mutationId'),
    requestDigest: decodeB64Url(requestDigest, 32, 'requestDigest'),
    action,
    resultVersion,
    resultChangeSequence,
    status: 'applied',
    expiresTime: new Date(Date.now() + 24 * 3600 * 1000),
  });
}