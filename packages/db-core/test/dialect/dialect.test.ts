import { describe, expect, it } from 'vitest';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';
import { DialectRegistry } from '../../src/dialect/dialectRegistry';
import { DatabaseType } from '../../src/types/connection';

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
    expect(() => DialectRegistry.get('ES' as unknown as DatabaseType)).toThrowError(
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

  describe('索引与触发器 DDL', () => {
    it('MySQL 生成建/删索引与触发器删除 SQL', () => {
      const d = new MysqlDialect();
      expect(d.createIndexSql('idx', 'users', ['id', 'name'], true, 'app')).toBe(
        'CREATE UNIQUE INDEX `idx` ON `app`.`users` (`id`, `name`)',
      );
      expect(d.dropIndexSql('idx', 'users', 'app')).toBe('DROP INDEX `idx` ON `app`.`users`');
      expect(d.dropTriggerSql('trg', 'users', 'app')).toBe('DROP TRIGGER IF EXISTS `app`.`trg`');
    });

    it('PostgreSQL 生成建/删索引与触发器删除 SQL', () => {
      const d = new PostgreSqlDialect();
      expect(d.createIndexSql('idx', 'users', ['id'], false)).toBe('CREATE INDEX "idx" ON "users" ("id")');
      expect(d.dropIndexSql('idx', 'users')).toBe('DROP INDEX IF EXISTS "idx"');
      expect(d.dropTriggerSql('trg', 'users')).toBe('DROP TRIGGER IF EXISTS "trg" ON "users"');
    });

    it('SQLite 生成建/删索引与触发器删除 SQL', () => {
      const d = new SqliteDialect();
      expect(d.createIndexSql('idx', 'users', ['id'], true)).toBe('CREATE UNIQUE INDEX "idx" ON "users" ("id")');
      expect(d.dropIndexSql('idx', 'users')).toBe('DROP INDEX IF EXISTS "idx"');
      expect(d.dropTriggerSql('trg', 'users')).toBe('DROP TRIGGER IF EXISTS "trg"');
    });

    it('触发器列表 SQL 非空', () => {
      expect(new MysqlDialect().getTriggerListSql('users', 'app')).toContain('TRIGGERS');
      expect(new PostgreSqlDialect().getTriggerListSql('users')).toContain('pg_trigger');
      expect(new SqliteDialect().getTriggerListSql('users')).toContain("type = 'trigger'");
    });
  });
});
describe('方言模板（建表 / 例程）', () => {
  /**
   * 回归：建表模板必须按方言给。命令层曾统一发 MySQL 语法
   * （`INT AUTO_INCREMENT PRIMARY KEY`），PG/SQLite 用户拿到的模板不可执行。
   */
  it('建表模板各方言自增主键写法不同', () => {
    expect(new MysqlDialect().createTableTemplate('`t`')).toContain('AUTO_INCREMENT PRIMARY KEY');
    expect(new PostgreSqlDialect().createTableTemplate('"t"')).toContain('SERIAL PRIMARY KEY');
    expect(new SqliteDialect().createTableTemplate('"t"')).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
  });

  it('建表模板包含传入的表标识符', () => {
    expect(new MysqlDialect().createTableTemplate('`db`.`t`')).toContain('`db`.`t`');
    expect(new PostgreSqlDialect().createTableTemplate('"s"."t"')).toContain('"s"."t"');
  });

  it('建表模板不互相串方言语法', () => {
    expect(new PostgreSqlDialect().createTableTemplate('"t"')).not.toContain('AUTO_INCREMENT');
    expect(new SqliteDialect().createTableTemplate('"t"')).not.toContain('AUTO_INCREMENT PRIMARY KEY');
    expect(new MysqlDialect().createTableTemplate('`t`')).not.toContain('SERIAL');
  });

  /** DELIMITER 是 MySQL 客户端命令，PG 不认；SQLite 无例程概念。 */
  it('例程模板：MySQL 用 DELIMITER，PG 用 $$ LANGUAGE，SQLite 返回空', () => {
    const mysql = new MysqlDialect().createRoutineTemplate('r');
    expect(mysql).toContain('DELIMITER');
    expect(mysql).toContain('CREATE PROCEDURE r()');

    const pg = new PostgreSqlDialect().createRoutineTemplate('r');
    expect(pg).toContain('LANGUAGE plpgsql');
    expect(pg).not.toContain('DELIMITER');

    expect(new SqliteDialect().createRoutineTemplate('r')).toBe('');
  });

  it('方言注册表取到的实例带模板方法', () => {
    for (const dbType of [DatabaseType.MYSQL, DatabaseType.PG, DatabaseType.SQLITE]) {
      const d = DialectRegistry.get(dbType)!;
      expect(typeof d.createTableTemplate).toBe('function');
      expect(typeof d.createRoutineTemplate).toBe('function');
      expect(d.createTableTemplate('"x"')).toContain('CREATE TABLE');
    }
  });
});