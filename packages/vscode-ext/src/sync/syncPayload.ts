import type { ConnectionGroup, SavedConnection } from '../connection/connectionStore';
import type { QueryFolder } from '../connection/queryStore';
import type { SavedQuery } from '@db-client/core';
import type { QueryHistoryEntry } from '../history/historyStore';

/**
 * 同步负载：跨设备同步的全量本地状态。
 * 整体由 SyncManager 经 AES-256-GCM 加密后上传，服务端只见密文。
 * `version` 用于向后兼容旧负载（无 version 字段视为旧版连接树）。
 */
export interface SyncPayload {
  version: 1;
  groups: ConnectionGroup[];
  /** 含密码（materialize）与软删除墓碑 */
  connections: SavedConnection[];
  /** 含软删除墓碑 */
  queries: SavedQuery[];
  queryFolders: QueryFolder[];
  history: QueryHistoryEntry[];
}

/**
 * 将解密后的任意对象归一化为 SyncPayload。
 *  - 旧版负载（无 version，仅 {groups, connections}）：补空集，仅还原连接树。
 *  - 新版负载：原样返回（缺字段补空集）。
 */
export function parseSyncPayload(raw: unknown): SyncPayload {
  const obj = (raw ?? {}) as Partial<SyncPayload> & { groups?: ConnectionGroup[]; connections?: SavedConnection[] };
  if (obj.version === 1) {
    return {
      version: 1,
      groups: obj.groups ?? [],
      connections: obj.connections ?? [],
      queries: obj.queries ?? [],
      queryFolders: obj.queryFolders ?? [],
      history: obj.history ?? [],
    };
  }
  // 旧版：仅连接树
  return {
    version: 1,
    groups: obj.groups ?? [],
    connections: obj.connections ?? [],
    queries: [],
    queryFolders: [],
    history: [],
  };
}
