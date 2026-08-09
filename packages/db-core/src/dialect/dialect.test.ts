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

  it('为每个方言显式声明对象与操作能力', () => {
    expect(new MysqlDialect().capabilities.operations).toContain('schemaSync');
    expect(new PostgreSqlDialect().capabilities.operations).toContain('renameTable');
    expect(new PostgreSqlDialect().capabilities.operations).not.toContain('schemaSync');
    expect(new PostgreSqlDialect().capabilities.multiDatabaseExplorer).toBe(false);
    expect(new MysqlDialect().capabilities.multiDatabaseExplorer).toBe(true);
    expect(new SqliteDialect().capabilities.events).toBe(false);
    expect(new SqliteDialect().capabilities.operations).not.toContain('truncateTable');
  });

  it('解析表列表行为统一 TableMeta', () => {
    const meta = new MysqlDialect().parseTableList([
      { name: 'users', comment: '用户表', table_rows: '10' },
    ]);
    expect(meta[0]).toMatchObject({ name: 'users', comment: '用户表' });
  });

  describe('buildInsertSql 方言化导出', () => {
    const rows = [
      { id: 1, name: "O'Brien", bio: null, score: 3.5, flag: true },
      { id: 2, name: 'back\\slash', bio: { k: 1 }, score: -2, flag: false },
    ];
    const columns = ['id', 'name', 'bio', 'score', 'flag'];

    it('MySQL 用反引号并限定 database，转义反斜杠', () => {
      const sql = new MysqlDialect().buildInsertSql(rows, columns, 'users', 'app');
      expect(sql).toContain('INSERT INTO `app`.`users` (`id`, `name`, `bio`, `score`, `flag`) VALUES');
      expect(sql).toContain("'O''Brien'");
      expect(sql).toContain("'back\\\\slash'");
      expect(sql).toContain('NULL');
      expect(sql).toContain('3.5');
      expect(sql).toContain('1');
      expect(sql).toContain('0');
    });

    it('MySQL 无 database 时不前置限定', () => {
      const sql = new MysqlDialect().buildInsertSql(rows, columns, 'users');
      expect(sql).toContain('INSERT INTO `users`');
      expect(sql).not.toContain('`app`');
    });

    it('PostgreSQL 用双引号并限定 schema，不转义反斜杠', () => {
      const sql = new PostgreSqlDialect().buildInsertSql(rows, columns, 'users', 'public');
      expect(sql).toContain('INSERT INTO "public"."users" ("id", "name", "bio", "score", "flag")');
      expect(sql).toContain("'O''Brien'");
      expect(sql).toContain("'back\\slash'");
      expect(sql).toContain('TRUE');
      expect(sql).toContain('FALSE');
    });

    it('SQLite 用双引号但不限定 database', () => {
      const sql = new SqliteDialect().buildInsertSql(rows, columns, 'users', 'ignored');
      expect(sql).toContain('INSERT INTO "users" ("id", "name", "bio", "score", "flag")');
      expect(sql).not.toContain('"ignored"');
      expect(sql).toContain("'O''Brien'");
      expect(sql).toMatch(/VALUES \(1,/);
      expect(sql).toMatch(/, 0\);/);
    });

    it('空行只产出空字符串', () => {
      expect(new MysqlDialect().buildInsertSql([], columns, 'users', 'app')).toBe('');
    });
  });
});
