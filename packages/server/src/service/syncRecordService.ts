import type { TxRunner, Queryable } from '../repository/mysql/db.js';
import type {
  ISyncStateRepo,
  ISyncRecordRepo,
  ISyncNonceRepo,
  ISyncMutationRepo,
  IPersonalSubscriptionRepo,
} from '../repository/interfaces.js';
import type { PersonalSyncState, PersonalConnectionMeta } from '../domain/entities.js';
import {
  SyncNotInitializedError,
  SyncVersionConflictError,
  SyncNonceReusedError,
  SyncQuotaExceededError,
  ValidationError,
  EntityNotFoundError,
} from '../domain/errors.js';
import { incU64 } from '../domain/syncU64.js';
import { SYNC_DOMAIN, assertU64, assertEpoch, verifySignature, checkReceipt, recordReceipt } from './syncShared.js';

const MAX_RECORD_CIPHERTEXT_BYTES = 256 * 1024; // 256 KiB（§8.1.7）
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;       // 2 MiB（§8.1.9）

interface SignedRecordMutation {
  keyEpoch: string;
  mutationId: string;       // Base64Url22
  signature: Buffer;        // 64B
  baseVersion: string;      // u64（"0"=create）
  requestDigest: string;    // Base64Url43
}

export interface PutRecordInput extends SignedRecordMutation {
  recordId: string;         // base64url 1..128 raw bytes
  cipherSuite: 'AES-256-GCM';
  formatVersion: 1;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export interface DeleteRecordInput extends SignedRecordMutation {
  recordId: string;
}

export interface RecordDto {
  recordId: string;
  cipherSuite?: string;
  formatVersion?: number;
  nonce?: string;
  ciphertext?: string;
  tag?: string;
  version: string;
  changeSequence: string;
  updateTime?: string;
  deleteTime: string | null;
}

export interface PullResult {
  snapshotSequence: string;
  nextAfter?: string;
  records: RecordDto[];
}

function decodeRecordId(recordId: string): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(recordId, 'base64url');
  } catch {
    throw new ValidationError('recordId is not valid base64url');
  }
  if (buf.length < 1 || buf.length > 128) throw new ValidationError('recordId must be 1..128 bytes');
  return buf;
}

function withSeq(state: PersonalSyncState, changeSequence: string): Omit<PersonalSyncState, 'createTime' | 'updateTime'> {
  const { createTime: _c, updateTime: _u, ...rest } = state;
  return { ...rest, changeSequence };
}

function toRecordDto(m: PersonalConnectionMeta): RecordDto {
  const base = {
    recordId: m.recordId.toString('base64url'),
    version: m.version,
    changeSequence: m.changeSequence,
    deleteTime: m.deleteTime ? m.deleteTime.toISOString() : null,
  };
  if (m.deleteTime) return base;
  return {
    ...base,
    cipherSuite: m.cipherSuite,
    formatVersion: m.formatVersion,
    nonce: m.nonce.toString('base64url'),
    ciphertext: m.ciphertext?.toString('base64url'),
    tag: m.tag?.toString('base64url'),
    updateTime: m.updateTime.toISOString(),
  };
}

function quotaEnabled(n: number): boolean {
  return n > 0;
}

export class SyncRecordService {
  constructor(
    private readonly stateRepo: ISyncStateRepo,
    private readonly recordRepo: ISyncRecordRepo,
    private readonly nonceRepo: ISyncNonceRepo,
    private readonly mutationRepo: ISyncMutationRepo,
    private readonly subscriptionRepo: IPersonalSubscriptionRepo,
    private readonly runner: TxRunner,
  ) {}

  async pull(userId: number, after: string, snapshotSequence: string | undefined, limit: number): Promise<PullResult> {
    assertU64(after, 'after');
    if (snapshotSequence !== undefined) assertU64(snapshotSequence, 'snapshotSequence');
    return this.runner(async (tx) => {
      const state = await this.lockActive(tx, userId);
      const snap = snapshotSequence ?? state.changeSequence;
      const metas = await this.recordRepo.listByFeed(tx, userId, state.keyEpoch, after, snap, limit);

      const records: RecordDto[] = [];
      let bytes = 0;
      let nextAfter: string | undefined;
      for (const m of metas) {
        const blobBytes = (m.ciphertext?.length ?? 0) + 16 + 12;
        if (records.length > 0 && bytes + blobBytes > MAX_RESPONSE_BYTES) {
          nextAfter = records[records.length - 1].changeSequence;
          break;
        }
        records.push(toRecordDto(m));
        bytes += blobBytes;
      }
      if (nextAfter === undefined && metas.length === limit && records.length > 0) {
        nextAfter = records[records.length - 1].changeSequence;
      }
      return { snapshotSequence: snap, nextAfter, records };
    });
  }

  async putRecord(userId: number, input: PutRecordInput): Promise<{ version: string; changeSequence: string }> {
    assertU64(input.keyEpoch, 'keyEpoch');
    assertU64(input.baseVersion, 'baseVersion');
    if (input.ciphertext.length > MAX_RECORD_CIPHERTEXT_BYTES) throw new ValidationError('record ciphertext exceeds 256 KiB');
    if (input.nonce.length !== 12) throw new ValidationError('invalid record nonce');
    if (input.tag.length !== 16) throw new ValidationError('invalid record tag');
    const recordIdBuf = decodeRecordId(input.recordId);

    return this.runner(async (tx) => {
      const state = await this.lockActive(tx, userId);
      assertEpoch(state, input.keyEpoch);
      const receipt = await checkReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest);
      if (receipt) return { version: receipt.resultVersion ?? state.changeSequence, changeSequence: receipt.resultChangeSequence ?? state.changeSequence };

      verifySignature(state.signPub, {
        domain: SYNC_DOMAIN, action: 'record.put', userId: String(userId), keyEpoch: input.keyEpoch,
        baseVersion: input.baseVersion, recordId: input.recordId, mutationId: input.mutationId, requestDigest: input.requestDigest,
      }, input.signature);

      // nonce ledger：复用即时拒绝（§8.1.5）。
      if (!(await this.nonceRepo.insert(tx, userId, input.keyEpoch, input.nonce))) throw new SyncNonceReusedError();

      const create = input.baseVersion === '0';
      const changeSeq = incU64(state.changeSequence);

      if (create) {
        const existing = await this.recordRepo.findForUpdate(tx, userId, input.keyEpoch, recordIdBuf);
        if (existing) throw new SyncVersionConflictError(existing.version);
        await this.assertRecordQuota(tx, userId, input.keyEpoch, { countDelta: 1, bytesDelta: input.ciphertext.length + 16 + 12 });
        await this.recordRepo.create(tx, {
          userId, keyEpoch: input.keyEpoch, recordId: recordIdBuf,
          cipherSuite: input.cipherSuite, formatVersion: input.formatVersion,
          nonce: input.nonce, ciphertext: input.ciphertext, tag: input.tag,
          version: '1', changeSequence: changeSeq,
        });
      } else {
        const existing = await this.recordRepo.findForUpdate(tx, userId, input.keyEpoch, recordIdBuf);
        if (!existing || existing.deleteTime) throw new EntityNotFoundError('record', input.recordId);
        const bytesDelta = (input.ciphertext.length + 16 + 12) - ((existing.ciphertext?.length ?? 0) + 16 + 12);
        await this.assertRecordQuota(tx, userId, input.keyEpoch, { countDelta: 0, bytesDelta });
        const newVersion = incU64(existing.version);
        const ok = await this.recordRepo.update(tx, {
          userId, keyEpoch: input.keyEpoch, recordId: recordIdBuf,
          baseVersion: input.baseVersion,
          cipherSuite: input.cipherSuite, formatVersion: input.formatVersion,
          nonce: input.nonce, ciphertext: input.ciphertext, tag: input.tag,
          newVersion, changeSequence: changeSeq,
        });
        if (!ok) throw new SyncVersionConflictError(existing.version);
      }

      const persisted = await this.stateRepo.update(tx, userId, state.stateVersion, withSeq(state, changeSeq));
      if (!persisted) throw new SyncVersionConflictError(state.stateVersion);

      await recordReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest, 'record.put', create ? '1' : incU64(input.baseVersion), changeSeq);
      return { version: create ? '1' : incU64(input.baseVersion), changeSequence: changeSeq };
    });
  }

  async deleteRecord(userId: number, input: DeleteRecordInput): Promise<{ version: string; changeSequence: string }> {
    assertU64(input.keyEpoch, 'keyEpoch');
    assertU64(input.baseVersion, 'baseVersion');
    const recordIdBuf = decodeRecordId(input.recordId);

    return this.runner(async (tx) => {
      const state = await this.lockActive(tx, userId);
      assertEpoch(state, input.keyEpoch);
      const receipt = await checkReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest);
      if (receipt) return { version: receipt.resultVersion ?? state.changeSequence, changeSequence: receipt.resultChangeSequence ?? state.changeSequence };

      verifySignature(state.signPub, {
        domain: SYNC_DOMAIN, action: 'record.delete', userId: String(userId), keyEpoch: input.keyEpoch,
        baseVersion: input.baseVersion, recordId: input.recordId, mutationId: input.mutationId, requestDigest: input.requestDigest,
      }, input.signature);

      const existing = await this.recordRepo.findForUpdate(tx, userId, input.keyEpoch, recordIdBuf);
      if (!existing || existing.deleteTime) throw new EntityNotFoundError('record', input.recordId);

      const changeSeq = incU64(state.changeSequence);
      const newVersion = incU64(existing.version);
      const ok = await this.recordRepo.softDelete(tx, userId, input.keyEpoch, recordIdBuf, input.baseVersion, newVersion, changeSeq, new Date());
      if (!ok) throw new SyncVersionConflictError(existing.version);

      const persisted = await this.stateRepo.update(tx, userId, state.stateVersion, withSeq(state, changeSeq));
      if (!persisted) throw new SyncVersionConflictError(state.stateVersion);

      await recordReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest, 'record.delete', newVersion, changeSeq);
      return { version: newVersion, changeSequence: changeSeq };
    });
  }

  // ── 私有 ──

  private async lockActive(tx: Queryable, userId: number): Promise<PersonalSyncState> {
    const state = await this.stateRepo.lockByUserId(tx, userId);
    if (!state) throw new SyncNotInitializedError();
    return state;
  }

  private async assertRecordQuota(tx: Queryable, userId: number, keyEpoch: string, delta: { countDelta: number; bytesDelta: number }): Promise<void> {
    const sub = await this.subscriptionRepo.findByUserId(userId);
    const snapshot = (sub?.entitlementSnapshot ?? {}) as Record<string, unknown>;
    const maxMetas = Number(snapshot.maxConnectionMetas ?? 0);
    const maxBytes = Number(snapshot.syncStorageBytes ?? 0);
    const current = await this.recordRepo.countActive(tx, userId, keyEpoch);

    if (quotaEnabled(maxMetas)) {
      const nextCount = current.count + delta.countDelta;
      if (nextCount > maxMetas) throw new SyncQuotaExceededError('count', String(maxMetas), String(nextCount));
    }
    if (quotaEnabled(maxBytes)) {
      const nextBytes = current.bytes + delta.bytesDelta;
      if (nextBytes > maxBytes) throw new SyncQuotaExceededError('bytes', String(maxBytes), String(nextBytes));
    }
  }
}