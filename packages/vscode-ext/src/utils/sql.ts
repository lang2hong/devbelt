import { DatabaseType } from '@db-client/core';
import type { SavedConnection } from '../connection/connectionStore';

/**
 * SQL 标识符包裹工具（统一 wrapIdent / wrapQualified，消除重复）。
 *
 * MySQL/SQLite 用反引号，PostgreSQL 用双引号。
 */
export function wrapIdent(conn: SavedConnection, name: string): string {
  return conn.dbType === DatabaseType.MYSQL ? '`' + name + '`' : '"' + name + '"';
}

/** 包裹限定名：`db`.`table` */
export function wrapQualified(conn: SavedConnection, name: string, database?: string): string {
  if (database) {
    return wrapIdent(conn, database) + '.' + wrapIdent(conn, name);
  }
  return wrapIdent(conn, name);
}

/** 转义 SQL 字符串字面量值（防注入，处理反斜杠） */
export function escapeSqlValue(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}
