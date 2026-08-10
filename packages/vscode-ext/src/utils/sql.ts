import { DatabaseType } from '@db-client/core';
import type { SavedConnection } from '../connection/connectionStore';

/**
 * SQL 标识符包裹工具（统一 wrapIdent / wrapQualified，消除重复）。
 *
 * MySQL/SQLite 用反引号，PostgreSQL 用双引号。
 */

/** 包裹标识符（基于方言类型）。 */
export function wrapIdent(dbType: DatabaseType, name: string): string {
  return dbType === DatabaseType.MYSQL ? '`' + name + '`' : '"' + name + '"';
}

/** 便捷版：基于已保存连接。 */
export function wrapIdentForConn(conn: SavedConnection, name: string): string {
  return wrapIdent(conn.dbType, name);
}

/** 转义 SQL 字符串字面量内容（不含外层引号，防注入）。 */
export function escapeSqlString(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "''");
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
