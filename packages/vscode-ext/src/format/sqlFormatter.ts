import { format, SqlLanguage } from 'sql-formatter';
import { DatabaseType } from '@db-client/core';

/**
 * SQL 格式化：按数据库方言调用 sql-formatter。
 */
export function formatSql(sql: string, dbType?: DatabaseType): string {
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
  return format(sql, { language: dialect, tabWidth: 2 });
}