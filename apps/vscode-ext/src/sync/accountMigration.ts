import type { Memento } from 'vscode';
import { scopedKey } from './accountScope';

/**
 * 账号首次使用时把本机（local）数据复制到该账号（方案 B1）。
 *
 * - 只复制、不移动：原数据保留，登出后仍能看到；
 * - 每个账号问一次（标记位 `devbelt.scope.<id>.migrated`），之后不再提示；
 * - 只处理「属于账号」的数据：连接/分组/保存的查询、查询历史、审计日志。
 */
export const MIGRATION_KEYS = [
  'devbelt.connections',
  // 保存的查询与文件夹（ConnectionStore 内部的 QueryStore 用独立键）
  'devbelt.queries',
  'devbelt.queryFolders',
  'devbelt.history',
  'devbelt.auditLog',
  // 定时备份计划：里面的 connId 也属于连接
  'devbelt.backup.schedules',
] as const;

export function migrationMarker(scope: string): string {
  return `devbelt.scope.${scope}.migrated`;
}

/** 是否需要询问迁移：该账号没被问过，且本机有连接数据。 */
export function migrationOffer(memento: Memento, scope: string): { needed: boolean; connections: number } {
  if (!scope || scope === 'local') return { needed: false, connections: 0 };
  if (memento.get<boolean>(migrationMarker(scope))) return { needed: false, connections: 0 };
  const scoped = memento.get<unknown[]>(scopedKey('devbelt.connections', scope));
  if (Array.isArray(scoped) && scoped.length > 0) return { needed: false, connections: 0 };
  const legacy = memento.get<{ connections?: unknown[] } | unknown[]>('devbelt.connections');
  const count = Array.isArray(legacy) ? legacy.length : Array.isArray(legacy?.connections) ? legacy.connections.length : 0;
  return { needed: count > 0, connections: count };
}

/** 复制本机数据到账号（目标已有值时不覆盖）。 */
export async function migrateScope(memento: Memento, scope: string): Promise<void> {
  if (!scope || scope === 'local') return;
  for (const base of MIGRATION_KEYS) {
    const target = scopedKey(base, scope);
    if (memento.get(target) !== undefined) continue;
    const legacy = memento.get(base);
    if (legacy !== undefined) await memento.update(target, legacy);
  }
}

/** 记录已询问（无论复制与否）。 */
export async function markMigrationAsked(memento: Memento, scope: string): Promise<void> {
  if (!scope || scope === 'local') return;
  await memento.update(migrationMarker(scope), true);
}