import { DatabaseType } from '@db-client/core';
import type { CachedEntitlement } from './authService';

/**
 * 个人连接许可证门禁（§8.1.6 扩展端口径裁定）。
 *
 * 两轴语义：
 *  - 权益轴＝fail-open：`CachedEntitlement` 缺失（未登录/登出已清缓存）时放行，
 *    不比对 allowedDatabaseTypes——个人连接本地优先，离线/首次启动不可阻断本地
 *    PostgreSQL。有缓存才按 allowedDatabaseTypes 门禁。
 *  - 引擎轴＝fail-closed：`DatabaseType` 映射表之外（未知/新增引擎）一律拒绝，
 *    不透传放行。
 *
 * 本文件零 vscode 依赖，纯函数可单测。
 */

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

/** 有缓存返回允许列表；无缓存返回 undefined（fail-open：不受限）。 */
export function allowedEngines(entitlement?: CachedEntitlement | null): readonly string[] | undefined {
  return entitlement?.allowedDatabaseTypes;
}

export function isDatabaseTypeAllowed(dbType: DatabaseType, entitlement?: CachedEntitlement | null): boolean {
  const engine = databaseEngineOf(dbType); // 未知引擎 fail-closed
  if (!entitlement) return true; // 无权益放行
  return entitlement.allowedDatabaseTypes.includes(engine);
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