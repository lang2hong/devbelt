import { assertRecordId, assertU64Decimal } from './types';
import type { MementoLike } from './stateStore';

/**
 * record ↔ connectionId 双向映射。
 *
 * 键按 userId + keyEpoch 隔离。持久化 recordId / connectionId / 服务端确认的
 * `recordVersion` / 本地连接 revision 标记（用 `updateTime` 毫秒）。组织连接（connectionId
 * 以 `org:` 开头）一律拒绝入映射。**双向不变量**：任何时刻 recordId 与 connectionId 一一
 * 对应；违反时 fail-closed。写操作异步（await memento.update），读操作同步。
 */

export type RecordMapStatus = 'pending' | 'confirmed';

export interface RecordMapEntry {
  connectionId: string;
  recordVersion: string;
  revision: number;
  status: RecordMapStatus;
}

interface RecordMapData {
  byRecordId: Record<string, RecordMapEntry>;
  byConnectionId: Record<string, string>;
}

function assertConnectionId(id: string): void {
  if (!id) throw new Error('connectionId must not be empty');
  if (id.startsWith('org:')) throw new Error('organization connection must not enter personal sync map');
}

function assertStatus(status: unknown): asserts status is RecordMapStatus {
  if (status !== 'pending' && status !== 'confirmed') throw new Error('corrupt record map: invalid status');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class RecordMapStore {
  private static readonly KEY_PREFIX = 'dbclient.sync.recordMap';

  private readonly key: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly memento: MementoLike,
    userId: string,
    keyEpoch: string,
  ) {
    assertU64Decimal(userId, 'userId');
    assertU64Decimal(keyEpoch, 'keyEpoch');
    this.key = `${RecordMapStore.KEY_PREFIX}.${userId}.${keyEpoch}`;
  }

  private read(): RecordMapData {
    const raw = this.memento.get<unknown>(this.key);
    if (raw === undefined) return { byRecordId: {}, byConnectionId: {} };
    if (!isPlainObject(raw)) throw new Error('corrupt record map: expected object');
    if (!isPlainObject(raw.byRecordId) || !isPlainObject(raw.byConnectionId)) {
      throw new Error('corrupt record map: missing byRecordId/byConnectionId');
    }

    const byRecordId: RecordMapData['byRecordId'] = {};
    for (const [recordId, entryRaw] of Object.entries(raw.byRecordId)) {
      assertRecordId(recordId);
      if (!isPlainObject(entryRaw)) throw new Error('corrupt record map: invalid record entry');
      if (typeof entryRaw.connectionId !== 'string') throw new Error('corrupt record map: invalid record entry');
      assertConnectionId(entryRaw.connectionId);
      if (typeof entryRaw.recordVersion !== 'string') throw new Error('corrupt record map: invalid record entry');
      assertU64Decimal(entryRaw.recordVersion, 'recordVersion');
      const revision = entryRaw.revision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        throw new Error('corrupt record map: invalid revision');
      }
      // 兼容：status 是本代新增的 additive 字段，旧条目缺失时语义上即为已确认。
      const status = entryRaw.status === undefined ? 'confirmed' : entryRaw.status;
      assertStatus(status);
      byRecordId[recordId] = { connectionId: entryRaw.connectionId, recordVersion: entryRaw.recordVersion, revision, status };
    }

    const byConnectionId: RecordMapData['byConnectionId'] = {};
    for (const [connectionId, recordIdRaw] of Object.entries(raw.byConnectionId)) {
      assertConnectionId(connectionId);
      if (typeof recordIdRaw !== 'string') throw new Error('corrupt record map: invalid reverse index entry');
      assertRecordId(recordIdRaw);
      byConnectionId[connectionId] = recordIdRaw;
    }

    // 双射校验：两张索引大小一致且正反向一一对应。
    if (Object.keys(byRecordId).length !== Object.keys(byConnectionId).length) {
      throw new Error('corrupt record map: index sizes do not match');
    }
    for (const [recordId, entry] of Object.entries(byRecordId)) {
      if (byConnectionId[entry.connectionId] !== recordId) {
        throw new Error('corrupt record map: reverse index does not match');
      }
    }

    return { byRecordId, byConnectionId };
  }

  private async write(data: RecordMapData): Promise<void> {
    await this.memento.update(this.key, data);
  }

  private mutate(change: () => Promise<void>): Promise<void> {
    const operation = this.writeChain.then(async () => {
      await change();
    });
    // 持久化失败后仍保持后续操作可用，同时把失败返回给发起调用者。
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  getByRecordId(recordId: string): (RecordMapEntry & { recordId: string }) | undefined {
    assertRecordId(recordId);
    const entry = this.read().byRecordId[recordId];
    return entry ? { recordId, ...entry } : undefined;
  }

  getByConnectionId(connectionId: string): (RecordMapEntry & { recordId: string }) | undefined {
    assertConnectionId(connectionId);
    const recordId = this.read().byConnectionId[connectionId];
    if (!recordId) return undefined;
    const entry = this.read().byRecordId[recordId];
    return entry ? { recordId, ...entry } : undefined;
  }

  async put(recordId: string, entry: RecordMapEntry): Promise<void> {
    assertRecordId(recordId);
    assertConnectionId(entry.connectionId);
    assertU64Decimal(entry.recordVersion, 'recordVersion');
    assertStatus(entry.status);
    return this.mutate(async () => {
      const current = this.read();
      // Validate and mutate a copy so a rejected reassignment cannot corrupt persisted state.
      const data: RecordMapData = {
        byRecordId: { ...current.byRecordId },
        byConnectionId: { ...current.byConnectionId },
      };
      // 双射不变量：先清旧反向指针，再拒绝目标 connectionId 被其他 record 占用。
      const old = data.byRecordId[recordId];
      if (old && old.connectionId !== entry.connectionId) {
        delete data.byConnectionId[old.connectionId];
      }
      const occupiedBy = data.byConnectionId[entry.connectionId];
      if (occupiedBy !== undefined && occupiedBy !== recordId) {
        throw new Error(`connectionId ${entry.connectionId} already mapped to recordId ${occupiedBy}`);
      }
      data.byRecordId[recordId] = entry;
      data.byConnectionId[entry.connectionId] = recordId;
      await this.write(data);
    });
  }

  async deleteByRecordId(recordId: string): Promise<void> {
    return this.mutate(async () => {
      const current = this.read();
      const data: RecordMapData = {
        byRecordId: { ...current.byRecordId },
        byConnectionId: { ...current.byConnectionId },
      };
      const entry = data.byRecordId[recordId];
      if (entry) delete data.byConnectionId[entry.connectionId];
      delete data.byRecordId[recordId];
      await this.write(data);
    });
  }

  async deleteByConnectionId(connectionId: string): Promise<void> {
    return this.mutate(async () => {
      const current = this.read();
      const data: RecordMapData = {
        byRecordId: { ...current.byRecordId },
        byConnectionId: { ...current.byConnectionId },
      };
      const recordId = data.byConnectionId[connectionId];
      if (recordId) delete data.byRecordId[recordId];
      delete data.byConnectionId[connectionId];
      await this.write(data);
    });
  }

  async clear(): Promise<void> {
    return this.mutate(async () => {
      await this.write({ byRecordId: {}, byConnectionId: {} });
    });
  }
}
