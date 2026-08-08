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

/**
 * 拆分 SQL 语句（按分号，感知引号内分号）。
 * 处理 single-quote, double-quote, backtick 三种引号上下文，跳过 -- 单行注释和 块注释。
 */
export function splitSqlStatements(sql: string): string[] {
  const result: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释 -- ...
    if (!inSingle && !inDouble && !inBacktick && ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) { i = sql.length; continue; }
      buf += sql.slice(i, nl);
      i = nl;
      continue;
    }
    // 块注释 /* ... */
    if (!inSingle && !inDouble && !inBacktick && ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      i = stop;
      continue;
    }
    // 引号切换
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (ch === '\x60' && !inSingle && !inDouble) inBacktick = !inBacktick;

    // 分号（仅在引号外）
    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      const stmt = buf.trim();
      if (stmt) result.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const last = buf.trim();
  if (last) result.push(last);
  return result;
}
