import { DatabaseType } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { ConnectionManager } from '../connection/connectionManager.js';
import type { SqlConnectionSession } from '../connection/connectionSession.js';

/**
 * 找到与连接（+当前库）匹配的**已打开** SQL 会话（P9 缺陷修复）。
 *
 * 键规则必须与 `ConnectionManager.connect` 一致：
 * - 非 PG（MySQL/SQLite）恒用**主会话键**（键 = conn.id，不含库名，切库走 `USE`）；
 * - PG 且给了非配置库 → 库衍生会话（键含库名）；衍生缺失时**不回退主会话**（防串库刷错 schema）。
 *
 * 背景：直接 `peekSql(connId, conn.database)` 对 MySQL 会因库名参与查找而落空
 * （主会话条目 database 恒为 undefined）——表现为面板"连接未打开"，即使连接明明开着。
 */
export function peekSqlForConnection(
  manager: ConnectionManager,
  conn: SavedConnection,
  database?: string,
): SqlConnectionSession | undefined {
  if (conn.dbType === DatabaseType.PG && database && database !== conn.database) {
    return manager.peekSql(conn.id, database);
  }
  return manager.peekSql(conn.id);
}