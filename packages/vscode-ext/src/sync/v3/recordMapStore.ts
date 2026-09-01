import { assertRecordId, assertU64Decimal } from './types';
import type { MementoLike } from './stateStore';

/**
 * record ↔ connectionId 双向映射（B3b，§8.1.5 + ADR-0007 #3 裁定）。
 *
 * 键按 userId + keyEpoch 隔离。持久化 recordId / connectionId / 服务端确认的
 * `recordVersion` / 本地连接 revision 标记（用 `updateTime` 毫秒），供「同 version
 * 重放不重复写」「更高 version 才进冲突检查」「本地脏判定」使用。组织连接（connectionId
 * 以 `org:` 开头）一律拒绝入映射。recordId 为 CSPRNG 16B base64url，必不与 connectionId 复用。
 */

export interface RecordMapEntry {
  connectionId: string;
  /** 服务端确认的 record version（u64 十进制） */
  recordVersion: string;
  /** 最后成功应用时本地连接的 updateTime（毫秒），本地脏判定用 */
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

  private write(data: RecordMapData): void {
    void this.memento.update(this.key, data);
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

  put(recordId: string, entry: RecordMapEntry): void {
    assertRecordId(recordId);
    assertConnectionId(entry.connectionId);
    assertU64Decimal(entry.recordVersion, 'recordVersion');
    const data = this.read();
    data.byRecordId[recordId] = entry;
    data.byConnectionId[entry.connectionId] = recordId;
    this.write(data);
  }

  deleteByRecordId(recordId: string): void {
    const data = this.read();
    const entry = data.byRecordId[recordId];
    if (entry) delete data.byConnectionId[entry.connectionId];
    delete data.byRecordId[recordId];
    this.write(data);
  }

  deleteByConnectionId(connectionId: string): void {
    const data = this.read();
    const recordId = data.byConnectionId[connectionId];
    if (recordId) delete data.byRecordId[recordId];
    delete data.byConnectionId[connectionId];
    this.write(data);
  }

  clear(): void {
    this.write({ byRecordId: {}, byConnectionId: {} });
  }
}