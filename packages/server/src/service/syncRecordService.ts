import type { TxRunner, Queryable } from '../repository/mysql/db.js';
import type {
  ISyncStateRepo,
  ISyncRecordRepo,
  ISyncNonceRepo,
  ISyncMutationRepo,
  IPersonalSubscriptionRepo,
  IPlanRepo,
} from '../repository/interfaces.js';
import type { PersonalSyncState, PersonalConnectionMeta } from '../domain/entities.js';
import { deriveEntitlement } from './entitlement.js';
import {
  SyncNotInitializedError,
  SyncVersionConflictError,
  SyncNonceReusedError,
  SyncQuotaExceededError,
  SyncRecordNotFoundError,
  ValidationError,
} from '../domain/errors.js';
import { incU64, parseU64 } from '../domain/syncU64.js';
import { decodeB64UrlRange } from './syncCrypto.js';
import { SYNC_DOMAIN, assertU64, assertEpoch, verifySignature, checkReceipt, recordReceipt } from './syncShared.js';

const MAX_RECORD_CIPHERTEXT_BYTES = 256 * 1024; // 单个 record 密文上限
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;       // feed 分页响应上限

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
  // canonical base64url：拒绝带 padding / 末字符低位等非规范形态，否则不同字符串
  // 可能解码出同一批字节，同一物理记录可挂到多个各自合法签名的身份下。
  return decodeB64UrlRange(recordId, 1, 128, 'recordId');
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
    private readonly planRepo: IPlanRepo,
    private readonly runner: TxRunner,
  ) {}

  async pull(userId: number, after: string, snapshotSequence: string | undefined, limit: number): Promise<PullResult> {
    assertU64(after, 'after');
    if (snapshotSequence !== undefined) assertU64(snapshotSequence, 'snapshotSequence');
    return this.runner(async (tx) => {
      const state = await this.lockActive(tx, userId);
      const snap = snapshotSequence ?? state.changeSequence;
      if (parseU64(snap) > parseU64(state.changeSequence)) throw new ValidationError('snapshotSequence must not exceed current changeSequence');
      if (parseU64(after) > parseU64(snap)) throw new ValidationError('after must not exceed snapshotSequence');
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
      if (receipt) {
      if (receipt.resultVersion === null || receipt.resultChangeSequence === null) {
        throw new Error('corrupt mutation receipt');
      }
      return { version: receipt.resultVersion, changeSequence: receipt.resultChangeSequence };
    }

      verifySignature(state.signPub, {
        domain: SYNC_DOMAIN, action: 'record.put', userId: String(userId), keyEpoch: input.keyEpoch,
        baseVersion: input.baseVersion, recordId: input.recordId, mutationId: input.mutationId, requestDigest: input.requestDigest,
      }, input.signature);

      // nonce ledger：复用即时拒绝（§7.4）。
      //
      // 台账插入**刻意**与业务写在同一事务内，不要改成「先独立提交、尝试即烧」：
      //
      // ① 台账要防的是「同一 nonce 的两份**不同**密文同时落库」—— 那才让读到库
      //    （备份泄露/DBA/入侵）的人能异或出明文 XOR。同事务保证了不变量
      //    「nonce 在台账 ⟺ 对应密文已持久化」严格成立：回滚时密文根本没落库，
      //    因此也不该占用 nonce。
      // ② 客户端是**原样重放**语义：outbox 持久化了 nonce/ciphertext/tag 并在重试时
      //    逐字节重发（见 vscode-ext/src/sync/e2e/pendingMutationStore.ts 头注释）。
      //    若改成尝试即烧，一次事务失败（锁等待、配额、网络中断）之后，那条 outbox
      //    条目会因 nonce 已烧而永久 SYNC_NONCE_REUSED，再也推不上去。
      // ③ 已提交后的原样重放不会走到这里：checkReceipt 在上方先命中并直接返回。
      //
      // 换言之「同 nonce + 同密文」是正常重试（安全），「同 nonce + 异密文」才是威胁，
      // 而后者只要有一次成功提交就会被这里拦住。
      if (!(await this.nonceRepo.insert(tx, userId, input.keyEpoch, input.nonce))) throw new SyncNonceReusedError();

      const create = input.baseVersion === '0';
      const changeSeq = incU64(state.changeSequence);

      if (create) {
        const existing = await this.recordRepo.findForUpdate(tx, userId, input.keyEpoch, recordIdBuf);
        // 墓碑也算「已存在」→ 409。这是刻意的：客户端的 recordId 由 randomBytes
        // 随机生成（vscode-ext/src/sync/e2e/syncMutator.ts mintId），删除时连映射
        // 一起清掉，新建必然拿到全新 id，所以正常流程**不会**用 create 命中墓碑。
        // 一旦命中，说明客户端状态已错乱（或存在重放），此时静默覆盖墓碑会让
        // 其它设备看到一条「复活」却无从判断是否该信任 —— 报冲突让客户端重新对齐。
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
        if (!existing) throw new SyncRecordNotFoundError();
        if (existing.deleteTime) throw new SyncVersionConflictError(existing.version);
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
      if (receipt) {
      if (receipt.resultVersion === null || receipt.resultChangeSequence === null) {
        throw new Error('corrupt mutation receipt');
      }
      return { version: receipt.resultVersion, changeSequence: receipt.resultChangeSequence };
    }

      verifySignature(state.signPub, {
        domain: SYNC_DOMAIN, action: 'record.delete', userId: String(userId), keyEpoch: input.keyEpoch,
        baseVersion: input.baseVersion, recordId: input.recordId, mutationId: input.mutationId, requestDigest: input.requestDigest,
      }, input.signature);

      const existing = await this.recordRepo.findForUpdate(tx, userId, input.keyEpoch, recordIdBuf);
      if (!existing) throw new SyncRecordNotFoundError();
      if (existing.deleteTime) throw new SyncVersionConflictError(existing.version);

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
    const sub = await this.subscriptionRepo.findByUserIdInTx(tx, userId);
    const plan = sub ? await this.planRepo.findByIdInTx(tx, sub.planId) : undefined;
    const freePlan = await this.planRepo.findByCodeInTx(tx, 'free');
    const snapshot = deriveEntitlement(sub, plan, freePlan);
    const maxMetas = Number(snapshot.maxConnectionMetas ?? 0);
    const maxBytes = Number(snapshot.syncStorageBytes ?? 0);
    const current = await this.recordRepo.countActive(tx, userId, keyEpoch);

    if (quotaEnabled(maxMetas)) {
      const nextCount = current.count + delta.countDelta;
      if (nextCount > maxMetas) throw new SyncQuotaExceededError('count', String(maxMetas), String(current.count));
    }
    if (quotaEnabled(maxBytes)) {
      const nextBytes = current.bytes + delta.bytesDelta;
      if (nextBytes > maxBytes) throw new SyncQuotaExceededError('bytes', String(maxBytes), String(current.bytes));
    }
  }
}
