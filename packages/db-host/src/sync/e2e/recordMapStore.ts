import { assertRecordId, assertU64Decimal } from './types.js';
import { refKey, assertSyncEntityType, isOrgLocalId, type SyncEntityRef, type SyncEntityType } from './syncEntity.js';
import type { MementoLike } from './stateStore.js';

/**
 * record ↔ 本地实体 的**类型化**双向映射（A1）。
 *
 * 键按 userId + keyEpoch 隔离。持久化 recordId / { type, localId } / 服务端确认的
 * `recordVersion` / 本地实体 revision 标记（updateTime 毫秒). 组织连接（type='connection'
 * 且 localId 以 `org:` 开头）一律拒绝入映射；其余类型（group/query/queryFolder）的 localId
 * 无 org: 概念。**双向不变量**：任何时刻 recordId 与 (type, localId) 一一对应；违反时
 * fail-closed。写操作异步（await memento.update），读操作同步。
 */

export type RecordMapStatus = 'pending' | 'confirmed';

export interface RecordMapEntry {
  type: SyncEntityType;
  localId: string;
  recordVersion: string;
  revision: number;
  status: RecordMapStatus;
}

interface RecordMapData {
  byRecordId: Record<string, RecordMapEntry>;
  byLocal: Record<string, string>;
}

function assertLocalEntry(type: SyncEntityType, localId: string): void {
  if (!localId) throw new Error('localId must not be empty');
  if (isOrgLocalId(type, localId)) throw new Error('organization connection must not enter personal sync map');
}

function assertStatus(status: unknown): asserts status is RecordMapStatus {
  if (status !== 'pending' && status !== 'confirmed') throw new Error('corrupt record map: invalid status');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class RecordMapStore {
  private static readonly KEY_PREFIX = 'devbelt.sync.recordMap';

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
    this.key = `${RecordMapStore.KEY_PREFIX}.${userId}.${keyEpoch}`;
  }

  private read(): RecordMapData {
    const raw = this.memento.get<unknown>(this.key);
    if (raw === undefined) return { byRecordId: {}, byLocal: {} };
    if (!isPlainObject(raw)) throw new Error('corrupt record map: expected object');
    if (!isPlainObject(raw.byRecordId) || !isPlainObject(raw.byLocal)) {
      throw new Error('corrupt record map: missing byRecordId/byLocal');
    }

    const byRecordId: RecordMapData['byRecordId'] = {};
    for (const [recordId, entryRaw] of Object.entries(raw.byRecordId)) {
      assertRecordId(recordId);
      if (!isPlainObject(entryRaw)) throw new Error('corrupt record map: invalid record entry');
      const type = assertSyncEntityType(entryRaw.type);
      if (typeof entryRaw.localId !== 'string') throw new Error('corrupt record map: invalid record entry');
      assertLocalEntry(type, entryRaw.localId);
      if (typeof entryRaw.recordVersion !== 'string') throw new Error('corrupt record map: invalid record entry');
      assertU64Decimal(entryRaw.recordVersion, 'recordVersion');
      const revision = entryRaw.revision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        throw new Error('corrupt record map: invalid revision');
      }
      assertStatus(entryRaw.status);
      byRecordId[recordId] = { type, localId: entryRaw.localId, recordVersion: entryRaw.recordVersion, revision, status: entryRaw.status };
    }

    const byLocal: RecordMapData['byLocal'] = {};
    for (const [localKey, recordIdRaw] of Object.entries(raw.byLocal)) {
      const sep = localKey.indexOf(':');
      if (sep < 0) throw new Error('corrupt record map: invalid local index key');
      const type = assertSyncEntityType(localKey.slice(0, sep));
      const localId = localKey.slice(sep + 1);
      assertLocalEntry(type, localId);
      if (typeof recordIdRaw !== 'string') throw new Error('corrupt record map: invalid reverse index entry');
      assertRecordId(recordIdRaw);
      byLocal[localKey] = recordIdRaw;
    }

    // 双射校验：两张索引大小一致且正反向一一对应。
    if (Object.keys(byRecordId).length !== Object.keys(byLocal).length) {
      throw new Error('corrupt record map: index sizes do not match');
    }
    for (const [recordId, entry] of Object.entries(byRecordId)) {
      if (byLocal[refKey({ type: entry.type, localId: entry.localId })] !== recordId) {
        throw new Error('corrupt record map: reverse index does not match');
      }
    }

    return { byRecordId, byLocal };
  }

  private async write(data: RecordMapData): Promise<void> {
    await this.memento.update(this.key, data);
  }

  private mutate(change: () => Promise<void>): Promise<void> {
    const operation = this.writeChain.then(async () => {
      await change();
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  getByRecordId(recordId: string): (RecordMapEntry & { recordId: string }) | undefined {
    assertRecordId(recordId);
    const entry = this.read().byRecordId[recordId];
    return entry ? { recordId, ...entry } : undefined;
  }

  getByRef(ref: SyncEntityRef): (RecordMapEntry & { recordId: string }) | undefined {
    assertLocalEntry(ref.type, ref.localId);
    const recordId = this.read().byLocal[refKey(ref)];
    if (!recordId) return undefined;
    const entry = this.read().byRecordId[recordId];
    return entry ? { recordId, ...entry } : undefined;
  }

  /** 列出全部映射条目（供 epoch 迁移清理本地已同步实体）。 */
  list(): (RecordMapEntry & { recordId: string })[] {
    const data = this.read();
    return Object.entries(data.byRecordId).map(([recordId, entry]) => ({ recordId, ...entry }));
  }

  async put(recordId: string, entry: RecordMapEntry): Promise<void> {
    assertRecordId(recordId);
    assertLocalEntry(entry.type, entry.localId);
    assertU64Decimal(entry.recordVersion, 'recordVersion');
    assertStatus(entry.status);
    return this.mutate(async () => {
      const current = this.read();
      const data: RecordMapData = {
        byRecordId: { ...current.byRecordId },
        byLocal: { ...current.byLocal },
      };
      const newLocalKey = refKey({ type: entry.type, localId: entry.localId });
      // 双射不变量：先清旧反向指针，再拒绝目标 local 被其他 record 占用。
      const old = data.byRecordId[recordId];
      if (old && refKey({ type: old.type, localId: old.localId }) !== newLocalKey) {
        delete data.byLocal[refKey({ type: old.type, localId: old.localId })];
      }
      const occupiedBy = data.byLocal[newLocalKey];
      if (occupiedBy !== undefined && occupiedBy !== recordId) {
        throw new Error(`local entity ${newLocalKey} already mapped to recordId ${occupiedBy}`);
      }
      data.byRecordId[recordId] = entry;
      data.byLocal[newLocalKey] = recordId;
      await this.write(data);
    });
  }

  async deleteByRecordId(recordId: string): Promise<void> {
    return this.mutate(async () => {
      const current = this.read();
      const data: RecordMapData = {
        byRecordId: { ...current.byRecordId },
        byLocal: { ...current.byLocal },
      };
      const entry = data.byRecordId[recordId];
      if (entry) delete data.byLocal[refKey({ type: entry.type, localId: entry.localId })];
      delete data.byRecordId[recordId];
      await this.write(data);
    });
  }

  async deleteByRef(ref: SyncEntityRef): Promise<void> {
    return this.mutate(async () => {
      const current = this.read();
      const data: RecordMapData = {
        byRecordId: { ...current.byRecordId },
        byLocal: { ...current.byLocal },
      };
      const recordId = data.byLocal[refKey(ref)];
      if (recordId) delete data.byRecordId[recordId];
      delete data.byLocal[refKey(ref)];
      await this.write(data);
    });
  }

  async clear(): Promise<void> {
    return this.mutate(async () => {
      await this.write({ byRecordId: {}, byLocal: {} });
    });
  }
}