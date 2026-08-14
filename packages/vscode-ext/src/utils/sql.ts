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

/**
 * 转义 SQL 字符串字面量内容（不含外层引号，防注入）。
 *
 * 转义规则按方言分流：MySQL 默认开启反斜杠转义，`\` 需翻倍；
 * PostgreSQL（standard_conforming_strings=on）与 SQLite 中反斜杠无转义语义，
 * 若照 MySQL 规则翻倍会把一个反斜杠写成两个字面反斜杠，导致匹配错误行。
 *
 * `dbType` 是**必填**：原先可省略并默认按 MySQL 处理，一旦调用方漏传，
 * PG/SQLite 上就会静默过度转义。方言差异不该有「默认值」。
 */
export function escapeSqlString(value: string, dbType: DatabaseType): string {
  const escaped = String(value).replace(/'/g, "''");
  return dbType === DatabaseType.MYSQL
    ? escaped.replace(/\\/g, '\\\\')
    : escaped;
}

/** 一条语句及其在源文本中的位置（供 CodeLens 定位）。 */
export interface SqlStatementRange {
  /** 语句文本（已 trim，不含结尾分号） */
  sql: string;
  /** 语句首字符在源文本中的偏移 */
  start: number;
  /** 语句末字符之后的偏移 */
  end: number;
}

/**
 * 拆分 SQL 语句并记录位置，是本仓库唯一的语句切分实现。
 *
 * 引号上下文（单引号 / 双引号 / 反引号）内的分号不切分；`--` 行注释与
 * `/* *\/` 块注释整体跳过，其中的分号同样不切分。
 *
 * CodeLens 曾自带一份不处理注释的实现，`-- note; more` 会把一条语句切成两半。
 * 两处必须共用同一套规则，否则「CodeLens 显示的段」与「实际执行的段」不一致。
 */
export function splitSqlWithRanges(sql: string): SqlStatementRange[] {
  const result: SqlStatementRange[] = [];
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let i = 0;
  // 当前语句在源文本中的起始偏移（含尚未 trim 的前导空白/注释）
  let segStart = 0;

  /** 把 [segStart, endExclusive) 去除首尾空白后作为一条语句收集。 */
  const flush = (endExclusive: number): void => {
    const raw = sql.slice(segStart, endExclusive);
    const trimmed = raw.trim();
    if (trimmed) {
      const lead = raw.length - raw.trimStart().length;
      const start = segStart + lead;
      result.push({ sql: trimmed, start, end: start + trimmed.length });
    }
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释 -- ...：跳过整段，注释内的分号不参与切分
    if (!inSingle && !inDouble && !inBacktick && ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    // 块注释 /* ... */
    if (!inSingle && !inDouble && !inBacktick && ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    // 引号切换
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (ch === '\x60' && !inSingle && !inDouble) inBacktick = !inBacktick;

    // 分号（仅在引号外）：语句到此结束，分号本身不计入语句文本
    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      flush(i);
      segStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
  flush(sql.length);
  return result;
}

/**
 * 拆分 SQL 语句（按分号，感知引号与注释）。
 * 只要文本不要位置时用这个；需要位置见 `splitSqlWithRanges`。
 */
export function splitSqlStatements(sql: string): string[] {
  return splitSqlWithRanges(sql).map((s) => s.sql);
}
