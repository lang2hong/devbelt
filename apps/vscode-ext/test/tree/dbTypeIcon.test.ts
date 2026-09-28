import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { dbTypeIconFile } from '../../src/tree/dbTypeIcon';

describe('dbTypeIcon', () => {
  it('每种数据库类型映射到对应品牌图标文件', () => {
    expect(dbTypeIconFile(DatabaseType.MYSQL)).toBe('db-mysql.svg');
    expect(dbTypeIconFile(DatabaseType.PG)).toBe('db-postgresql.svg');
    expect(dbTypeIconFile(DatabaseType.SQLITE)).toBe('db-sqlite.svg');
    expect(dbTypeIconFile(DatabaseType.REDIS)).toBe('db-redis.svg');
  });

  it('按状态返回 dim/open/active 变体（open 为默认）', () => {
    expect(dbTypeIconFile(DatabaseType.REDIS)).toBe('db-redis.svg');
    expect(dbTypeIconFile(DatabaseType.REDIS, 'dim')).toBe('db-redis-dim.svg');
    expect(dbTypeIconFile(DatabaseType.REDIS, 'active')).toBe('db-redis-active.svg');
    expect(dbTypeIconFile(DatabaseType.MYSQL, 'dim')).toBe('db-mysql-dim.svg');
    expect(dbTypeIconFile(DatabaseType.PG, 'active')).toBe('db-postgresql-active.svg');
  });

  it('未知/缺失类型回退通用连接图标（无状态变体）', () => {
    expect(dbTypeIconFile(undefined)).toBe('connection.svg');
    expect(dbTypeIconFile('ORACLE' as DatabaseType)).toBe('connection.svg');
    expect(dbTypeIconFile(undefined, 'dim')).toBe('connection.svg');
  });
});