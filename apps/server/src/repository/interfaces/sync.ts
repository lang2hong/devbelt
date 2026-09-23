import type {
  PersonalSyncState,
  PersonalConnectionMeta,
  SyncMutation,
  SyncResetToken,
  SyncResetHandoff,
} from "../../domain/entities.js";
import type {
  SyncAction,
} from "../../domain/enums.js";
import type { Queryable } from "../mysql/db.js";

/** 仓储接口 · sync（自 interfaces.ts 按聚合拆分，纯类型移动）。 */

export interface ISyncStateRepo {
  /** 只读当前 active state（无锁）。 */
  findByUserId(userId: number): Promise<PersonalSyncState | undefined>;
  /** 事务内锁定 state 行（FOR UPDATE），所有 sync mutation 的序列化点。 */
  lockByUserId(exec: Queryable, userId: number): Promise<PersonalSyncState | undefined>;
  /** 首次建态（仅当无行）；已存在返回 false。init 用。 */
  create(exec: Queryable, state: Omit<PersonalSyncState, 'createTime' | 'updateTime'>): Promise<boolean>;
  /** 覆盖 state 行（change-key/recover/destroy/reset）：`WHERE user_id AND state_version=expectedStateVersion`。 */
  update(exec: Queryable, userId: number, expectedStateVersion: string, state: Omit<PersonalSyncState, 'createTime' | 'updateTime'>): Promise<boolean>;
}

export interface ISyncRecordRepo {
  create(exec: Queryable, input: {
    userId: number;
    keyEpoch: string;
    recordId: Buffer;
    cipherSuite: PersonalConnectionMeta['cipherSuite'];
    formatVersion: PersonalConnectionMeta['formatVersion'];
    nonce: Buffer;
    ciphertext: Buffer;
    tag: Buffer;
    version: string;
    changeSequence: string;
    /** P6：可选明文类型名；缺省 null。 */
    entityKind?: string | null;
  }): Promise<PersonalConnectionMeta>;
  /** 事务内按 (user_id, key_epoch, record_id) 锁定 record（FOR UPDATE）。 */
  findForUpdate(exec: Queryable, userId: number, keyEpoch: string, recordId: Buffer): Promise<PersonalConnectionMeta | undefined>;
  /** 乐观锁更新（`WHERE version=baseVersion AND delete_time IS NULL`）并写新 version/change_sequence。 */
  update(exec: Queryable, input: {
    userId: number;
    keyEpoch: string;
    recordId: Buffer;
    baseVersion: string;
    cipherSuite: PersonalConnectionMeta['cipherSuite'];
    formatVersion: PersonalConnectionMeta['formatVersion'];
    nonce: Buffer;
    ciphertext: Buffer;
    tag: Buffer;
    newVersion: string;
    changeSequence: string;
    /** P6：可选明文类型名；仅在提供时覆盖（缺省保留原值）。 */
    entityKind?: string | null;
  }): Promise<boolean>;
  /** 软删 tombstone：清空 ciphertext/tag、写 delete_time 与新 version/change_sequence。 */
  softDelete(exec: Queryable, userId: number, keyEpoch: string, recordId: Buffer, baseVersion: string, newVersion: string, changeSequence: string, now: Date): Promise<boolean>;
  /** feed：active epoch 内 `change_sequence > after AND <= snapshotSequence`，含 tombstone，按 change_sequence 升序。 */
  listByFeed(exec: Queryable, userId: number, keyEpoch: string, after: string, snapshotSequence: string, limit: number): Promise<PersonalConnectionMeta[]>;
  /** active record 数 + 密文字节（配额计量：ciphertext+tag+nonce 长度，§4.2）。锁内执行。 */
  countActive(exec: Queryable, userId: number, keyEpoch: string): Promise<{ count: number; bytes: number }>;
  /** 同步概览聚合：active epoch 的记录数、密文字节、最近活动时间（无 record 时 null）。 */
  overview(exec: Queryable, userId: number, keyEpoch: string): Promise<{ count: number; bytes: number; lastActivityTime: Date | null }>;
  /** 列出该 epoch 全部未删 record（destroy/reset 逐个 tombstone 用，持锁内调用）。 */
  listActiveByEpoch(exec: Queryable, userId: number, keyEpoch: string): Promise<PersonalConnectionMeta[]>;
  /** P6：按明文类型计数（active，不含 tombstone）。用于按类型配额/后台统计。 */
  countActiveByKind(exec: Queryable, userId: number, keyEpoch: string, entityKind: string): Promise<number>;
}

export interface ISyncNonceRepo {
  /** 插入 nonce；唯一键冲突返回 false（对应 SYNC_NONCE_REUSED），成功 true。 */
  insert(exec: Queryable, userId: number, keyEpoch: string, nonce: Buffer): Promise<boolean>;
}

export interface ISyncMutationRepo {
  /** 幂等查：返回该 mutationId 的 receipt（若有）。 */
  findByMutationId(exec: Queryable, userId: number, keyEpoch: string, mutationId: Buffer): Promise<SyncMutation | undefined>;
  /** UPSERT（by PK）一份已应用 mutation 的结果。 */
  record(exec: Queryable, input: {
    userId: number;
    keyEpoch: string;
    mutationId: Buffer;
    requestDigest: Buffer;
    action: SyncAction;
    resultVersion: string | null;
    resultChangeSequence: string | null;
    resultRecoveryCodeSetTime: Date | null;
    status: SyncMutation['status'];
    expiresTime: Date;
  }): Promise<void>;
  /**
   * 删除已过 expires_time 的 receipt。该列本就是为清理而设，但此前无人清 ——
   * 每次 record mutation 都插一行，不清理即无界增长。返回删除行数。
   * 本仓储无状态（不持连接池），故 exec 由调用方传入。
   */
  prune(exec: Queryable, before: Date, limit: number): Promise<number>;
}

export interface ISyncResetTokenRepo {
  create(exec: Queryable, input: { userId: number; tokenHash: Buffer; expiresTime: Date }): Promise<SyncResetToken>;
  /** 作废该用户全部未消费、未撤销 token（重新发起 challenge 前）。 */
  revokePendingByUser(exec: Queryable, userId: number, now: Date): Promise<void>;
  /** 事务内按 hash 锁定可用 token（未消费/未撤销/未过期）。 */
  findUsableForUpdate(exec: Queryable, tokenHash: Buffer): Promise<SyncResetToken | undefined>;
  /** 只读按 token_hash 查找（mail-flow 认领解析 target_record_id 用）。 */
  findByHash(tokenHash: Buffer): Promise<SyncResetToken | undefined>;
  /** 事务内按 id 锁定 reset token 行（handoff 消费锁序的第一把锁）。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<SyncResetToken | undefined>;
  /** 原子消费（`WHERE consumed_time IS NULL AND revoked_time IS NULL`）。 */
  consume(exec: Queryable, id: number, now: Date): Promise<boolean>;
  /** 删除已消费/已撤销/已过期且超出保留期的 token 行。返回删除行数。 */
  prune(exec: Queryable, before: Date, limit: number): Promise<number>;
}

export interface ISyncResetHandoffRepo {
  create(exec: Queryable, input: { userId: number; resetTokenId: number; ticketHash: Buffer; expiresTime: Date }): Promise<SyncResetHandoff>;
  /** 只读按 ticket_hash 查找（消费预检走锁前）。 */
  findByTicketHash(ticketHash: Buffer): Promise<SyncResetHandoff | undefined>;
  /** 事务内按 ticket_hash 锁定（唯一键）。 */
  findByTicketHashForUpdate(exec: Queryable, ticketHash: Buffer): Promise<SyncResetHandoff | undefined>;
  /** 撤销某 reset token 下全部 issued/processing 未终结 handoff（签发新 handoff 前）。 */
  revokePendingByResetToken(exec: Queryable, resetTokenId: number, now: Date): Promise<void>;
  /** 置 processing + 写 request_digest（最终 reset 首次进入）。 */
  markProcessing(exec: Queryable, id: number, requestDigest: Buffer, now: Date): Promise<void>;
  /** 置 completed + 写结果收据（result_state_dto_json + 冗余计数字段）。 */
  markCompleted(exec: Queryable, id: number, now: Date, result: { stateDtoJson: string; keyEpoch: string; stateVersion: string; changeSequence: string }): Promise<void>;
  /** processing 超时（60s，崩溃恢复）回退 issued。 */
  rollbackProcessing(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 过期 issued/processing → expired（清理任务，返回受影响行数）。 */
  expire(exec: Queryable, now: Date, limit: number): Promise<number>;
  /** 删除 completed/revoked/expired 且超出保留期的行。返回删除行数。 */
  prune(exec: Queryable, before: Date, limit: number): Promise<number>;
}
