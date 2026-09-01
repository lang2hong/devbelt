import { DatabaseType } from '@db-client/core';
import type { CachedEntitlement } from './authService';

/**
 * 个人连接许可证门禁（§8.1.6 扩展端口径裁定）。
 *
 * fail-closed 默认 Free：无 `CachedEntitlement`（未登录/登出已清缓存）时按
 * `DEFAULT_FREE_ENGINES` 兜底，与服务端匿名口径一致——仅 `postgresql` 被拒。
 * 映射表 fail-closed：未知/新增 `DatabaseType` 一律拒绝，不透传放行。
 *
 * 本文件零 vscode 依赖，纯函数可单测。
 */

export const DEFAULT_FREE_ENGINES: readonly string[] = ['mysql', 'sqlite'];

const ENGINE_BY_DB_TYPE: Readonly<Partial<Record<DatabaseType, string>>> = {
  [DatabaseType.MYSQL]: 'mysql',
  [DatabaseType.PG]: 'postgresql',
  [DatabaseType.SQLITE]: 'sqlite',
};

/** 权益不足/引擎不允许时的可诊断错误（各 UI 层据此映射 i18n 文案）。 */
export class PersonalEntitlementDeniedError extends Error {
  constructor(public readonly engine: string) {
    super(`database engine "${engine}" is not allowed by the current plan`);
    this.name = 'PersonalEntitlementDeniedError';
  }
}

/** dbType → engine 字符串；未知枚举抛错（fail-closed）。 */
export function databaseEngineOf(dbType: DatabaseType): string {
  const engine = ENGINE_BY_DB_TYPE[dbType];
  if (!engine) throw new Error(`unknown DatabaseType: ${String(dbType)}`);
  return engine;
}

/** 组织连接 id 前缀（与 commands/org.ts 的 toSavedConnection 构造保持一致）。 */
export const ORG_CONNECTION_ID_PREFIX = 'org:';

/** 依 id 前缀防御性识别组织连接（不含显式 scope）。 */
export function isOrganizationConnectionId(id?: string): boolean {
  return id?.startsWith(ORG_CONNECTION_ID_PREFIX) ?? false;
}

/** 当前允许的引擎集合：有缓存用缓存值，无缓存 fail-closed 到 Free。 */
export function allowedEngines(entitlement?: CachedEntitlement | null): readonly string[] {
  return entitlement?.allowedDatabaseTypes ?? DEFAULT_FREE_ENGINES;
}

export function isDatabaseTypeAllowed(dbType: DatabaseType, entitlement?: CachedEntitlement | null): boolean {
  return allowedEngines(entitlement).includes(databaseEngineOf(dbType));
}

/** 建连/保存/导入等个人连接写入点前的断言；违规抛 PersonalEntitlementDeniedError。 */
export function assertPersonalDatabaseType(dbType: DatabaseType, entitlement?: CachedEntitlement | null): void {
  if (!isDatabaseTypeAllowed(dbType, entitlement)) {
    throw new PersonalEntitlementDeniedError(databaseEngineOf(dbType));
  }
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