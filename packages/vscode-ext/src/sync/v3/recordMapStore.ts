import { assertRecordId, assertU64Decimal } from './types';
import type { MementoLike } from './stateStore';

/**
 * record ↔ connectionId 双向映射（B3b，§8.1.5 + ADR-0007 #3 裁定）。
 *
 * 键按 userId + keyEpoch 隔离。持久化 recordId / connectionId / 服务端确认的
 * `recordVersion` / 本地连接 revision 标记（用 `updateTime` 毫秒）。组织连接（connectionId
 * 以 `org:` 开头）一律拒绝入映射。**双向不变量**：任何时刻 recordId 与 connectionId 一一
 * 对应；违反时 fail-closed。写操作异步（await memento.update），读操作同步。
 */

export interface RecordMapEntry {
  connectionId: string;
  recordVersion: string;
  revision: number;
}

interface RecordMapData {
  byRecordId: Record<string, RecordMapEntry>;
  byConnectionId: Record<string, string>;
}

function assertConnectionId(id: string): void {
  if (!id) throw new Error('connectionId must not be empty');
  if (id.startsWith('org:')) throw new Error('organization connection must not enter personal sync map');
}

export class RecordMapStore {
  private static readonly KEY_PREFIX = 'dbclient.sync.v3.recordMap';

  private readonly key: string;

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
    const raw = this.memento.get<RecordMapData>(this.key);
    return raw ?? { byRecordId: {}, byConnectionId: {} };
  }

  private async write(data: RecordMapData): Promise<void> {
    await this.memento.update(this.key, data);
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
    const data = this.read();
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
  }

  async deleteByRecordId(recordId: string): Promise<void> {
    const data = this.read();
    const entry = data.byRecordId[recordId];
    if (entry) delete data.byConnectionId[entry.connectionId];
    delete data.byRecordId[recordId];
    await this.write(data);
  }

  async deleteByConnectionId(connectionId: string): Promise<void> {
    const data = this.read();
    const recordId = data.byConnectionId[connectionId];
    if (recordId) delete data.byRecordId[recordId];
    delete data.byConnectionId[connectionId];
    await this.write(data);
  }

  async clear(): Promise<void> {
    await this.write({ byRecordId: {}, byConnectionId: {} });
  }
}