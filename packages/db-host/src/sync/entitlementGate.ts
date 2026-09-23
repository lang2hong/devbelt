import { DatabaseType } from '@devbelt/db-core';
/** 缓存的个人权益（personal_plans entitlement_snapshot，不含时间字段）。 */
export interface CachedEntitlement {
  planCode: string;
  allowedDatabaseTypes: string[];
  maxDevices: number;
  /** 本机可保存连接数上限；0 = 不限。 */
  maxSavedConnections: number;
  /** 是否允许导入连接配置。 */
  allowConnectionImport: boolean;
  /** 可同时打开的连接数；0 = 不限。缺省视为 0（不限）。 */
  maxConcurrentConnections?: number;
  /** 是否允许导出连接配置。缺省视为允许。 */
  allowConnectionExport?: boolean;
  /** 是否允许 ER 图。缺省视为允许。 */
  allowErDiagram?: boolean;
  /** 是否允许数据同步。缺省视为允许。 */
  allowDataSync?: boolean;
  /** 可保存验证器条目上限；0 = 不限。缺省 fail-closed 到 DEFAULT_FREE_MAX_AUTH_ENTRIES。 */
  maxAuthenticatorEntries?: number;
}

/**
 * 个人同步的引擎权益过滤（§7.2 引擎门禁）。
 *
 * 本地连接不在此门禁内：本地引擎支持只看方言是否注册，权益门禁仅作用于
 * 个人同步入站 record 过滤（跨设备同步为 Pro 权益）。
 *
 * 过滤 fail-closed：无 `CachedEntitlement`（未登录/权益未拉取）时按
 * `DEFAULT_FREE_ENGINES` 兜底，与服务端匿名口径一致——仅 `postgresql` 被过滤；
 * 映射表 fail-closed：未知/新增 `DatabaseType` 保守判为不允许，不透传放行。
 *
 * 本文件零 vscode 依赖，纯函数可单测。
 */

export const DEFAULT_FREE_ENGINES: readonly string[] = ['mysql', 'sqlite'];

/** free 档本机可保存连接数上限（连接资产差异点）。 */
export const DEFAULT_FREE_MAX_CONNECTIONS = 10;

/** free 档可保存验证器条目上限（P5 新增）。 */
export const DEFAULT_FREE_MAX_AUTH_ENTRIES = 10;

const ENGINE_BY_DB_TYPE: Readonly<Partial<Record<DatabaseType, string>>> = {
  [DatabaseType.MYSQL]: 'mysql',
  [DatabaseType.PG]: 'postgresql',
  [DatabaseType.SQLITE]: 'sqlite',
};

/** dbType → engine 字符串；未知枚举抛错（fail-closed）。 */
export function databaseEngineOf(dbType: DatabaseType): string {
  const engine = ENGINE_BY_DB_TYPE[dbType];
  if (!engine) throw new Error(`unknown DatabaseType: ${String(dbType)}`);
  return engine;
}

/** 当前允许的引擎集合：有缓存用缓存值，无缓存 fail-closed 到 Free。 */
export function allowedEngines(entitlement?: CachedEntitlement | null): readonly string[] {
  return entitlement?.allowedDatabaseTypes ?? DEFAULT_FREE_ENGINES;
}

export function isDatabaseTypeAllowed(dbType: DatabaseType, entitlement?: CachedEntitlement | null): boolean {
  return allowedEngines(entitlement).includes(databaseEngineOf(dbType));
}

/** 本机可保存连接数上限；无缓存/无效值 fail-closed 到 free（10）。0 视为不限。 */
export function maxSavedConnections(entitlement?: CachedEntitlement | null): number {
  const v = entitlement?.maxSavedConnections;
  return typeof v === 'number' && v >= 0 ? v : DEFAULT_FREE_MAX_CONNECTIONS;
}

/** 是否允许导入连接配置；无缓存 fail-closed 到 free（禁止）。导出恒允许，无需此函数。 */
export function canImportConnections(entitlement?: CachedEntitlement | null): boolean {
  return entitlement?.allowConnectionImport === true;
}

export interface SkippedPersonalConnection {
  name: string;
  engine: string;
}

export interface PersonalConnectionFilterResult<T> {
  allowed: T[];
  skipped: SkippedPersonalConnection[];
}

/**
 * 同步应用远端连接前的过滤：违规引擎逐条跳过并收集清单，绝不整批失败、
 * 不删除本地已有连接。删除墓碑（deleted=true）永不门禁、原样保留以传播删除语义。
 */
export function filterPersonalConnectionsByEntitlement<
  T extends { dbType: DatabaseType; name?: string; deleted?: boolean },
>(
  connections: T[],
  entitlement?: CachedEntitlement | null,
): PersonalConnectionFilterResult<T> {
  const allowed: T[] = [];
  const skipped: SkippedPersonalConnection[] = [];
  for (const c of connections) {
    if (c.deleted) {
      allowed.push(c);
      continue;
    }
    try {
      if (isDatabaseTypeAllowed(c.dbType, entitlement)) {
        allowed.push(c);
      } else {
        skipped.push({ name: c.name ?? '', engine: databaseEngineOf(c.dbType) });
      }
    } catch {
      skipped.push({ name: c.name ?? '', engine: String(c.dbType) });
    }
  }
  return { allowed, skipped };
}
/** 可同时打开的最大连接数；0 = 不限（free 默认不限制）。 */
export function maxConcurrentConnections(entitlement?: CachedEntitlement | null): number {
  const v = entitlement?.maxConcurrentConnections;
  return typeof v === 'number' && v >= 0 ? v : 0;
}

/** 是否允许导出连接配置；默认允许（free 不限制）。 */
export function canExportConnections(entitlement?: CachedEntitlement | null): boolean {
  return entitlement?.allowConnectionExport !== false;
}

/** 是否允许 ER 图；默认允许。 */
export function canUseErDiagram(entitlement?: CachedEntitlement | null): boolean {
  return entitlement?.allowErDiagram !== false;
}

/** 是否允许数据同步；默认允许。 */
export function canUseDataSync(entitlement?: CachedEntitlement | null): boolean {
  return entitlement?.allowDataSync !== false;
}

/** 可保存验证器条目上限；无缓存/无效值 fail-closed 到 free（10）。0 视为不限。 */
export function maxAuthenticatorEntries(entitlement?: CachedEntitlement | null): number {
  const v = entitlement?.maxAuthenticatorEntries;
  return typeof v === 'number' && v >= 0 ? v : DEFAULT_FREE_MAX_AUTH_ENTRIES;
}
