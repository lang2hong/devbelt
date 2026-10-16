import type { SyncEntityType } from '@devbelt/db-host/sync/e2e/syncEntity';

/**
 * 选择性同步项（按机器生效，不随同步走；关闭 = 本机不推送、收到不应用（入 deferred 暂存，
 * 重开后重放）、本地数据保留）。
 *
 * 依赖级联：query/queryFolder/schemaNotes 都以 connId 引用 connection——关闭「连接与分组」
 * 时二者随之停用（引擎侧 typeEnabledOf 强制，设置页仅提示），否则引用会悬空成 unresolved。
 * aiModelAccess 的三组子项（选择/自定义/Key）见 ai/modelAccess.ts，属于该类型内部的粒度。
 */

export interface SyncItems {
  /** connection + group。 */
  connections: boolean;
  /** query + queryFolder（依赖 connections）。 */
  queries: boolean;
  /** schemaNotes 表/列注记（依赖 connections）。 */
  notes: boolean;
  /** 验证器三类（条目/分组/标签）。 */
  authenticator: boolean;
  /** AI 模型接入配置（内部再分三组子项）。 */
  aiModelAccess: boolean;
}

export const DEFAULT_SYNC_ITEMS: SyncItems = {
  connections: true,
  queries: true,
  notes: true,
  authenticator: true,
  aiModelAccess: true,
};

/** 解析设置值（不可信输入：缺省/类型非法的项回退为开）。 */
export function parseSyncItems(raw: unknown): SyncItems {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    connections: o.connections !== false,
    queries: o.queries !== false,
    notes: o.notes !== false,
    authenticator: o.authenticator !== false,
    aiModelAccess: o.aiModelAccess !== false,
  };
}

/** 实体类型 → 是否启用（含依赖级联）。 */
export function typeEnabledOf(items: SyncItems, type: SyncEntityType): boolean {
  switch (type) {
    case 'connection':
    case 'group':
      return items.connections;
    case 'query':
    case 'queryFolder':
      return items.connections && items.queries;
    case 'schemaNotes':
      return items.connections && items.notes;
    case 'authenticatorEntry':
    case 'authenticatorGroup':
    case 'authenticatorTag':
      return items.authenticator;
    case 'aiModelAccess':
      return items.aiModelAccess;
  }
}

/** 读取配置的最小面（测试可注入 fake）。 */
export interface ItemsConfigLike {
  get<T>(key: string, defaultValue: T): T;
}

/** 从 `devbelt` 配置节读取同步项（实时读取，改动下一轮同步生效——与 autoSync 同口径）。 */
export function readSyncItems(config: ItemsConfigLike): SyncItems {
  return parseSyncItems(config.get('sync.items', DEFAULT_SYNC_ITEMS as unknown as Record<string, unknown>));
}
