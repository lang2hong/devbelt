import { assertBase64UrlNoPad, assertRecordId, assertU64Decimal } from './types';
import { assertSyncEntityType, isOrgLocalId, type SyncEntityType } from './syncEntity';
import type { MementoLike } from './stateStore';

/**
 * 待推送 mutation outbox（A1：类型化）。
 *
 * 持久化完整已签名 record mutation，使请求发出后能原样重放（同 mutationId/nonce/
 * ciphertext/digest/signature）。不存明文实体、DEK、SMP 或私钥。键按 userId+keyEpoch
 * 隔离。每条 mutation 以 `type + localId` 标识其归属的本地实体（取代 connectionId）。
 * 分判联合：
 *  - `record.put`：必须含 nonce/ciphertext/tag（§7.5.1）。
 *  - `record.delete`：禁止 nonce/ciphertext/tag（DeleteRecordRequest 无这些字段）。
 */

/** 持久化的出站/入站冲突状态（B4）。密文字段仅入站冲突时携带。 */
export interface OutboxConflict {
  kind: 'version' | 'pending';
  /** 远端当前版本（Use Local 以此为 baseVersion 重新 rebase）。 */
  currentVersion: string;
  /** 远端 record 版本（与 currentVersion 一致；保留以对齐协议字段）。 */
  remoteRecordVersion: string;
  /** 远端密文（入站 enrich 且远端为 active 时携带；供 Use Remote 直接解密应用）。 */
  remoteNonce?: string;
  remoteCiphertext?: string;
  remoteTag?: string;
  /** 远端是否为 tombstone。三态：true=tombstone、false=active、undefined=尚未拉取（出站 409 未 enrich）。 */
  remoteTombstone?: boolean;
}

interface PendingBase {
  recordId: string;
  type: SyncEntityType;
  localId: string;
  baseVersion: string;
  mutationId: string;
  signature: string;
  requestDigest: string;
  /** 加密 payload 对应时刻的本地实体 revision（updateTime 毫秒），receipt 确认用。 */
  revision: number;
  /** 连续可重试失败轮次（仅 error 递增，成功/terminal/conflict 清终止）。 */
  consecutiveFailureCount: number;
  /** 未解决冲突（可选）；有值则自动同步在该 record 上暂停，等用户三态决策。 */
  conflict?: OutboxConflict;
}

export interface PendingPutMutation extends PendingBase {
  action: 'record.put';
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface PendingDeleteMutation extends PendingBase {
  action: 'record.delete';
}

export type PendingMutation = PendingPutMutation | PendingDeleteMutation;

function assertLocalEntry(type: SyncEntityType, localId: string): void {
  if (!localId) throw new Error('localId must not be empty');
  if (isOrgLocalId(type, localId)) throw new Error('organization connection must not enter outbox');
}

function assertBase(type: SyncEntityType, localId: string, recordId: string, baseVersion: string, mutationId: string, signature: string, requestDigest: string): void {
  assertLocalEntry(type, localId);
  assertRecordId(recordId);
  assertU64Decimal(baseVersion, 'baseVersion', true);
  assertBase64UrlNoPad(mutationId, 16, 'mutationId');
  assertBase64UrlNoPad(signature, 64, 'signature');
  assertBase64UrlNoPad(requestDigest, 32, 'requestDigest');
}

/** 全量协议校验：形状 + 字段长度/编码。put() 写入与 list() 读取共用同一口径。 */
function assertMutation(m: unknown): asserts m is PendingMutation {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    throw new Error('corrupt outbox entry: expected object');
  }
  const o = m as Record<string, unknown>;
  if (o.action !== 'record.put' && o.action !== 'record.delete') {
    throw new Error('corrupt outbox entry: invalid action');
  }
  if (typeof o.recordId !== 'string' || typeof o.baseVersion !== 'string' ||
    typeof o.mutationId !== 'string' || typeof o.signature !== 'string' ||
    typeof o.requestDigest !== 'string') {
    throw new Error('corrupt outbox entry: missing base field');
  }
  const type = assertSyncEntityType(o.type);
  if (typeof o.localId !== 'string') {
    throw new Error('corrupt outbox entry: missing localId');
  }
  assertBase(type, o.localId, o.recordId, o.baseVersion, o.mutationId, o.signature, o.requestDigest);
  if (typeof o.revision !== 'number' || !Number.isSafeInteger(o.revision) || o.revision < 0) {
    throw new Error('corrupt outbox entry: invalid revision');
  }
  if (typeof o.consecutiveFailureCount !== 'number' || !Number.isSafeInteger(o.consecutiveFailureCount) || o.consecutiveFailureCount < 0) {
    throw new Error('corrupt outbox entry: invalid consecutiveFailureCount');
  }
  if (o.conflict !== undefined) assertConflict(o.conflict);
  if (o.action === 'record.put') {
    if (typeof o.nonce !== 'string' || typeof o.ciphertext !== 'string' || typeof o.tag !== 'string') {
      throw new Error('corrupt outbox entry: put requires nonce/ciphertext/tag');
    }
    assertBase64UrlNoPad(o.nonce, 12, 'nonce');
    assertBase64UrlNoPad(o.tag, 16, 'tag');
    if (typeof o.ciphertext !== 'string' || !/^[A-Za-z0-9_-]+$/.test(o.ciphertext)) {
      throw new Error('corrupt outbox entry: ciphertext must be unpadded base64url');
    }
  } else if ('nonce' in o) {
    throw new Error('corrupt outbox entry: delete must not carry nonce');
  } else if ('ciphertext' in o) {
    throw new Error('corrupt outbox entry: delete must not carry ciphertext');
  } else if ('tag' in o) {
    throw new Error('corrupt outbox entry: delete must not carry tag');
  }
}

/** 全量校验冲突字段（形状 + 版本 u64 + 可选密文 base64url）。 */
function assertConflict(c: unknown): void {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    throw new Error('corrupt outbox conflict: expected object');
  }
  const o = c as Record<string, unknown>;
  if (o.kind !== 'version' && o.kind !== 'pending') {
    throw new Error('corrupt outbox conflict: invalid kind');
  }
  assertU64Decimal(typeof o.currentVersion === 'string' ? o.currentVersion : '', 'conflict.currentVersion', true);
  assertU64Decimal(typeof o.remoteRecordVersion === 'string' ? o.remoteRecordVersion : '', 'conflict.remoteRecordVersion', true);
  for (const k of ['remoteNonce', 'remoteCiphertext', 'remoteTag'] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v)) {
      throw new Error(`corrupt outbox conflict: invalid ${k}`);
    }
  }
  if (o.remoteTombstone !== undefined && typeof o.remoteTombstone !== 'boolean') {
    throw new Error('corrupt outbox conflict: invalid remoteTombstone');
  }
}

export class PendingMutationStore {
  private static readonly KEY_PREFIX = 'dbclient.sync.outbox';

  private readonly key: string;
  private writeChain: Promise<void> = Promise.resolve();
  readonly userId: string;
  readonly keyEpoch: string;

  constructor(
    private readonly memento: MementoLike,
    userId: string,
    keyEpoch: string,
  ) {
    assertU64Decimal(userId, 'userId');
    assertU64Decimal(keyEpoch, 'keyEpoch');
    this.userId = userId;
    this.keyEpoch = keyEpoch;
    this.key = `${PendingMutationStore.KEY_PREFIX}.${userId}.${keyEpoch}`;
  }

  list(): PendingMutation[] {
    const raw = this.memento.get<unknown>(this.key);
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Error('corrupt outbox: expected array');
    for (const item of raw) assertMutation(item);
    return raw as PendingMutation[];
  }

  async put(m: PendingMutation): Promise<void> {
    assertMutation(m);
    await this.mutate((list) => {
      if (list.some((x) => x.mutationId === m.mutationId)) {
        throw new Error(`outbox already contains mutationId ${m.mutationId}`);
      }
      return [...list, m];
    });
  }

  async delete(mutationId: string): Promise<void> {
    await this.mutate((list) => list.filter((m) => m.mutationId !== mutationId));
  }

  /** 仅更新 consecutiveFailureCount，签名/digest/nonce/ciphertext 等逐字段原样。 */
  async setFailureCount(mutationId: string, count: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('consecutiveFailureCount must be a non-negative safe integer');
    await this.mutate((list) => list.map((m) => (m.mutationId === mutationId ? { ...m, consecutiveFailureCount: count } : m)));
  }

  /** 设置某条 mutation 的冲突状态（B4 持久化）。 */
  async setConflict(mutationId: string, conflict: OutboxConflict): Promise<void> {
    assertConflict(conflict);
    await this.mutate((list) => list.map((m) => (m.mutationId === mutationId ? { ...m, conflict } : m)));
  }

  /** 清除某条 mutation 的冲突状态。 */
  async clearConflict(mutationId: string): Promise<void> {
    await this.mutate((list) => list.map((m) => {
      if (m.mutationId !== mutationId) return m;
      const { conflict, ...rest } = m as PendingMutation & { conflict?: OutboxConflict };
      return rest;
    }));
  }

  /** 原子替换某条 mutation（Use Local：旧 mutation 换为 rebase 后的新 mutation）。 */
  async replaceMutation(mutationId: string, next: PendingMutation): Promise<void> {
    assertMutation(next);
    await this.mutate((list) => {
      const idx = list.findIndex((m) => m.mutationId === mutationId);
      if (idx < 0) throw new Error(`outbox has no mutationId ${mutationId}`);
      if (list.some((m, i) => i !== idx && m.mutationId === next.mutationId)) {
        throw new Error(`outbox already contains mutationId ${next.mutationId}`);
      }
      const nextList = [...list];
      nextList[idx] = next;
      return nextList;
    });
  }

  async clear(): Promise<void> {
    await this.mutate(() => []);
  }

  private mutate(change: (list: PendingMutation[]) => PendingMutation[]): Promise<void> {
    const operation = this.writeChain.then(async () => {
      await this.write(change(this.list()));
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  private async write(list: PendingMutation[]): Promise<void> {
    await this.memento.update(this.key, list);
  }
}