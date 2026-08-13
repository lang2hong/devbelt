import { format, type SqlLanguage } from 'sql-formatter';
import * as vscode from 'vscode';
import { DatabaseType } from '@db-client/core';

/**
 * SQL 格式化：按数据库方言调用 sql-formatter，indent/keywordCase 可配置。
 */
export function formatSql(sql: string, dbType?: DatabaseType): string {
  const cfg = vscode.workspace.getConfiguration('dbclient.format');
  const tabWidth = cfg.get<number>('indent', 2);
  const keywordCase = cfg.get<'preserve' | 'upper' | 'lower'>('keywordCase', 'upper');
  let dialect: SqlLanguage = 'sql';
  switch (dbType) {
    case DatabaseType.MYSQL:
      dialect = 'mysql';
      break;
    case DatabaseType.PG:
      dialect = 'postgresql';
      break;
    case DatabaseType.SQLITE:
      dialect = 'sqlite';
      break;
  }
  return format(sql, { language: dialect, tabWidth, keywordCase });
}