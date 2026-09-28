/**
 * 数据库类型 + 连接状态 → 树节点图标文件名。
 *
 * 纯函数、无 vscode 运行时依赖，便于单测；图标资源位于 `resources/icons/`，
 * 由 provider 用 `extensionUri` 拼成 `TreeItem.iconPath`（浅/深色同图）。
 *
 * 三态：`dim`（未打开，灰色）/ `open`（已打开，品牌彩色）/ `active`（当前选中且已打开，彩色+绿点）。
 * 为手绘近似图标，非厂商官方素材。
 */
import { DatabaseType } from '@devbelt/db-core';

/** 连接节点图标状态。 */
export type ConnIconState = 'dim' | 'open' | 'active';

const ICON_BASE: Record<DatabaseType, string> = {
  [DatabaseType.MYSQL]: 'db-mysql',
  [DatabaseType.PG]: 'db-postgresql',
  [DatabaseType.SQLITE]: 'db-sqlite',
  [DatabaseType.REDIS]: 'db-redis',
};

/** 图标文件名；未知/缺失类型回退通用 `connection.svg`（无 dim/active 变体）。 */
export function dbTypeIconFile(dbType: DatabaseType | undefined, state: ConnIconState = 'open'): string {
  if (!dbType || !Object.prototype.hasOwnProperty.call(ICON_BASE, dbType)) return 'connection.svg';
  const base = ICON_BASE[dbType];
  if (state === 'dim') return `${base}-dim.svg`;
  if (state === 'active') return `${base}-active.svg`;
  return `${base}.svg`;
}