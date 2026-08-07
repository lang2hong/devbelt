import { describe, expect, it } from 'vitest';
import { MysqlDialect } from './mysqlDialect';
import { PostgreSqlDialect } from './postgreSqlDialect';
import { SqliteDialect } from './sqliteDialect';
import { DialectRegistry } from './dialectRegistry';
import { DatabaseType } from '../types/connection';

describe('方言策略（策略模式）', () => {
  it('MySQL 包裹标识符用反引号', () => {
    const d = new MysqlDialect();
    expect(d.wrap('users')).toBe('`users`');
  });

  it('PostgreSQL 与 SQLite 包裹标识符用双引号', () => {
    expect(new PostgreSqlDialect().wrap('users')).toBe('"users"');
    expect(new SqliteDialect().wrap('users')).toBe('"users"');
  });

  it('分页 SQL 生成符合各自方言', () => {
    expect(new MysqlDialect().getPagedSql('SELECT * FROM t', 10, 5)).toBe(
      'SELECT * FROM t LIMIT 10, 5',
    );
    expect(new PostgreSqlDialect().getPagedSql('SELECT * FROM t', 10, 5)).toBe(
      'SELECT * FROM t LIMIT 5 OFFSET 10',
    );
    expect(new SqliteDialect().getPagedSql('SELECT * FROM t', 10, 5)).toBe(
      'SELECT * FROM t LIMIT 5 OFFSET 10',
    );
  });

  it('注册表可解析已注册方言，未注册抛错', () => {
    expect(DialectRegistry.get(DatabaseType.MYSQL)).toBeInstanceOf(MysqlDialect);
    expect(DialectRegistry.has(DatabaseType.PG)).toBe(true);
    expect(() => DialectRegistry.get(DatabaseType.ES as any)).toThrowError(
      /Unsupported database type/,
    );
  });

  it('解析表列表行为统一 TableMeta', () => {
    const meta = new MysqlDialect().parseTableList([
      { name: 'users', comment: '用户表', table_rows: '10' },
    ]);
    expect(meta[0]).toMatchObject({ name: 'users', comment: '用户表' });
  });
});