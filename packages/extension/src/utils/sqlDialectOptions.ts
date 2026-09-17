import type { DatabaseType } from '@devkit/core';
import type { SqlScanOptions } from '@devkit/core/sql';
import { scanOptionsForDbType } from '@devkit/core/sql';

/**
 * 由连接方言派生 SQL 扫描选项；**委托** db-core 的单一来源 `scanOptionsForDbType`，
 * 避免 db-core 内部切分与编辑器侧各维护一份而漂移。
 */
export function dialectScanOptions(dbType: DatabaseType | undefined): SqlScanOptions {
  return scanOptionsForDbType(dbType);
}