/**
 * 同步实体的类型化基础设施（A1）。
 *
 * 同步对象从「仅连接」扩展为四类实体：连接 / 分组 / 保存查询 / 查询文件夹。这里定义
 * 判别类型 `SyncEntityType`、类型化引用 `SyncEntityRef { type, localId }` 与本地数据的
 * 类型化描述，作为 RecordMapStore / PendingMutationStore / codec / apply / mutator 全链路
 * 的统一口径；取代原先散落的 `connectionId` 字符串。
 */

export type SyncEntityType = 'connection' | 'group' | 'queryFolder' | 'query';

export const SYNC_ENTITY_TYPES: readonly SyncEntityType[] = ['connection', 'group', 'queryFolder', 'query'];

export interface SyncEntityRef {
  type: SyncEntityType;
  localId: string;
}

/** 类型化引用的稳定字符串键（用于 map 索引 / 去重键）。 */
export function refKey(ref: SyncEntityRef): string {
  return `${ref.type}:${ref.localId}`;
}

export function assertSyncEntityType(t: unknown): SyncEntityType {
  if (t === 'connection' || t === 'group' || t === 'queryFolder' || t === 'query') {
    return t;
  }
  throw new Error(`unknown sync entity type: ${String(t)}`);
}

export function assertSyncEntityRef(raw: unknown, field: string): SyncEntityRef {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${field} must be an object`);
  const o = raw as Record<string, unknown>;
  if (typeof o.localId !== 'string') throw new Error(`${field}.localId must be a string`);
  return { type: assertSyncEntityType(o.type), localId: o.localId };
}