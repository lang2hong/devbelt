import { describe, expect, it } from 'vitest';
import { TableService, validateColumnType } from '../../src/query/tableService';
import { QueryService } from '../../src/query/queryService';
import { IConnection } from '../../src/connection/connection';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';
import type { QueryCallback } from '../../src/types/query';

/** 内存假连接捕获 SQL */
class CaptureConnection extends IConnection {
  public sqls: string[] = [];
  /** 命中该正则的 SQL 返回指定 rows（如 `SELECT current_schema()`）；否则返回空 rows。 */
  public rowsFor?: { match: RegExp; rows: any[] };
  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }
  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    this.sqls.push(sql);
    const cb = callback || values;
    if (this.rowsFor?.match.test(sql)) {
      cb(null, { rows: this.rowsFor.rows, affectedRows: 0 }, []);
      return;
    }
    cb(null, { rows: [], affectedRows: 1 }, []);
  }
  connect(cb: (err: any) => void): void {
    cb(null);
  }
  beginTransaction(cb: (err: any) => void): void {
    cb(null);
  }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean {
    return true;
  }
}

describe('TableService（表操作）', () => {
  it('生成 DROP TABLE 并转义标识符', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.dropTable('users');
    expect(conn.sqls[0]).toBe('DROP TABLE `users`');
  });

  it('生成 RENAME TABLE', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.renameTable('users', 'accounts');
    expect(conn.sqls[0]).toBe('RENAME TABLE `users` TO `accounts`');
  });

  it('生成 TRUNCATE TABLE', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.truncateTable('users');
    expect(conn.sqls[0]).toBe('TRUNCATE TABLE `users`');
  });

  it('生成建表语句查询（MySQL）', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.getCreateSql('users');
    expect(conn.sqls[0]).toBe('SHOW CREATE TABLE `users`');
  });

  it('PostgreSQL 使用 ALTER TABLE 重命名', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new PostgreSqlDialect()));
    await svc.renameTable('users', 'accounts');
    expect(conn.sqls[0]).toBe('ALTER TABLE "users" RENAME TO "accounts"');
  });

  it('SQLite 不暴露 TRUNCATE TABLE', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new SqliteDialect()));
    await expect(svc.truncateTable('users')).rejects.toThrow(/does not support truncateTable/);
  });

  /**
   * PG 的库名 != schema：此前把 `database` 当 schema 包裹，生成 `IN SCHEMA "库名"`，
   * 授权到不存在的 schema。现在先查 current_schema() 再以标识符内插。
   */
  it('PG 授权目标为 current_schema() 解析出的 schema，而非库名', async () => {
    const conn = new CaptureConnection();
    conn.rowsFor = { match: /current_schema\(\)/, rows: [{ schema: 'public' }] };
    const svc = new TableService(new QueryService(conn, new PostgreSqlDialect()));
    await svc.grantPrivilege('alice', 'SELECT', 'mydb');
    expect(conn.sqls[0]).toContain('current_schema()');
    expect(conn.sqls[1]).toBe('GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "alice"');
    expect(conn.sqls[1]).not.toContain('mydb');
  });

  it('PG 撤销权限同样按 current_schema() 解析', async () => {
    const conn = new CaptureConnection();
    conn.rowsFor = { match: /current_schema\(\)/, rows: [{ schema: 'reporting' }] };
    const svc = new TableService(new QueryService(conn, new PostgreSqlDialect()));
    await svc.revokePrivilege('alice', 'SELECT', 'mydb');
    expect(conn.sqls[1]).toBe('REVOKE SELECT ON ALL TABLES IN SCHEMA "reporting" FROM "alice"');
  });

  it('MySQL 授权仍按 库.* 生成（不受 PG 改动影响）', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.grantPrivilege('alice', 'SELECT', 'mydb', '%');
    expect(conn.sqls[0]).toBe("GRANT SELECT ON `mydb`.* TO 'alice'@'%'");
  });

  it('recreatePrimaryKey：MySQL 用 DROP+ADD 单语句', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.recreatePrimaryKey('users', ['id', 'tenant']);
    expect(conn.sqls[0]).toBe('ALTER TABLE `users` DROP PRIMARY KEY, ADD PRIMARY KEY (`id`, `tenant`)');
  });

  it('recreatePrimaryKey：PG/SQLite 明确报不支持，不发 MySQL 语法', async () => {
    for (const dialect of [new PostgreSqlDialect(), new SqliteDialect()]) {
      const conn = new CaptureConnection();
      const svc = new TableService(new QueryService(conn, dialect));
      await expect(svc.recreatePrimaryKey('users', ['id'])).rejects.toThrow(/not supported/);
      expect(conn.sqls).toHaveLength(0);
    }
  });
});

/**
 * 建表（表设计器的建表表单）。
 *
 * 自增列的写法三家完全不同，过去命令层只发 MySQL 语法的模板，
 * PG / SQLite 用户拿到的 SQL 直接执行会报错。
 */
describe('TableService.createTable', () => {
  const spec = [
    { name: 'id', type: 'INT', isPrimary: true, autoIncrement: true },
    { name: 'name', type: 'VARCHAR(255)', notNull: true, defaultValue: 'anon', comment: '姓名' },
  ];

  it('MySQL：AUTO_INCREMENT + 独立 PRIMARY KEY + 列注释', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.createTable('users', spec, 'test');
    const sql = conn.sqls[0];
    expect(sql).toContain('CREATE TABLE `test`.`users`');
    expect(sql).toContain('`id` INT NOT NULL AUTO_INCREMENT');
    expect(sql).toContain("`name` VARCHAR(255) NOT NULL DEFAULT 'anon' COMMENT '姓名'");
    expect(sql).toContain('PRIMARY KEY (`id`)');
  });

  it('PostgreSQL：自增列换成 SERIAL，且不写列注释', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new PostgreSqlDialect()));
    await svc.createTable('users', spec);
    const sql = conn.sqls[0];
    expect(sql).toContain('"id" SERIAL');
    expect(sql).not.toContain('AUTO_INCREMENT');
    expect(sql).not.toContain('COMMENT');
    expect(sql).toContain('PRIMARY KEY ("id")');
  });

  it('PostgreSQL：bigint 自增用 BIGSERIAL', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new PostgreSqlDialect()));
    await svc.createTable('users', [{ name: 'id', type: 'BIGINT', isPrimary: true, autoIncrement: true }]);
    expect(conn.sqls[0]).toContain('"id" BIGSERIAL');
  });

  it('SQLite：自增写成内联 INTEGER PRIMARY KEY AUTOINCREMENT', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new SqliteDialect()));
    await svc.createTable('users', spec);
    const sql = conn.sqls[0];
    expect(sql).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    // 内联主键后不能再追加独立 PRIMARY KEY 子句
    expect(sql).not.toMatch(/PRIMARY KEY \(/);
  });

  it('SQLite：自增列必须是唯一主键，否则明确报错', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new SqliteDialect()));
    await expect(svc.createTable('users', [
      { name: 'id', type: 'INTEGER', isPrimary: true, autoIncrement: true },
      { name: 'tenant', type: 'INTEGER', isPrimary: true },
    ])).rejects.toThrow(/only primary key column/);
  });

  it('数字与 CURRENT_TIMESTAMP 默认值不加引号，其余按方言转义', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.createTable('t', [
      { name: 'a', type: 'INT', defaultValue: '0' },
      { name: 'b', type: 'DATETIME', defaultValue: 'CURRENT_TIMESTAMP' },
      { name: 'c', type: 'VARCHAR(10)', defaultValue: "it's" },
    ]);
    const sql = conn.sqls[0];
    expect(sql).toContain('`a` INT DEFAULT 0');
    expect(sql).toContain('`b` DATETIME DEFAULT CURRENT_TIMESTAMP');
    // 字符串默认值走方言转义（MySQL 单引号翻倍）
    expect(sql).toContain("`c` VARCHAR(10) DEFAULT 'it''s'");
  });

  it('无列时拒绝建表', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await expect(svc.createTable('t', [])).rejects.toThrow(/At least one column/);
  });

  it('多个自增列被拒绝', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await expect(svc.createTable('t', [
      { name: 'a', type: 'INT', autoIncrement: true },
      { name: 'b', type: 'INT', autoIncrement: true },
    ])).rejects.toThrow(/Only one auto-increment/);
  });

  it('非法表名/列名被拒绝（标识符校验）', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await expect(svc.createTable('bad name;drop', [{ name: 'a', type: 'INT' }])).rejects.toThrow();
    await expect(svc.createTable('t', [{ name: 'a`b', type: 'INT' }])).rejects.toThrow();
  });

  it('缺类型的列被拒绝', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await expect(svc.createTable('t', [{ name: 'a', type: '  ' }])).rejects.toThrow(/type is required/i);
  });
});

/**
 * 复制表。
 *
 * 此前 `dupTable` 只发 `CREATE TABLE ... LIKE`（注释却写着「含数据」），
 * 一行数据都不会复制；且 PG / SQLite 未声明 duplicateTable 能力，直接被拒。
 */
describe('TableService.dupTable', () => {
  it('MySQL：结构 + 数据是两条语句', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.dupTable('users', 'users_copy', 'test', true);
    expect(conn.sqls).toEqual([
      'CREATE TABLE `test`.`users_copy` LIKE `test`.`users`',
      'INSERT INTO `test`.`users_copy` SELECT * FROM `test`.`users`',
    ]);
  });

  it('MySQL：仅结构时不发 INSERT', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.dupTable('users', 'users_copy');
    expect(conn.sqls).toEqual(['CREATE TABLE `users_copy` LIKE `users`']);
  });

  it('PostgreSQL：用 LIKE ... INCLUDING ALL 保留索引与默认值', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new PostgreSqlDialect()));
    await svc.dupTable('users', 'users_copy', undefined, true);
    expect(conn.sqls[0]).toBe('CREATE TABLE "users_copy" (LIKE "users" INCLUDING ALL)');
    expect(conn.sqls[1]).toBe('INSERT INTO "users_copy" SELECT * FROM "users"');
  });

  it('SQLite：CREATE TABLE AS SELECT，仅结构时加 WHERE 0', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new SqliteDialect()));
    await svc.dupTable('users', 'c1', undefined, true);
    await svc.dupTable('users', 'c2', undefined, false);
    expect(conn.sqls).toEqual([
      'CREATE TABLE "c1" AS SELECT * FROM "users"',
      'CREATE TABLE "c2" AS SELECT * FROM "users" WHERE 0',
    ]);
  });

  it('非法表名被拒绝', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await expect(svc.dupTable('users', 'a`b')).rejects.toThrow();
  });
});

/**
 * 改列 / 改列名。
 *
 * 树上的「Modify」过去生成 `MODIFY COLUMN`，改不了列名 —— 而改名正是最常见的诉求。
 */
describe('TableService.changeColumn / renameColumn', () => {
  it('MySQL 用 CHANGE COLUMN，可同时改名与改定义', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.changeColumn('users', 'name', 'full_name', { type: 'VARCHAR(255)', notNull: true }, 'test');
    expect(conn.sqls[0]).toBe(
      'ALTER TABLE `test`.`users` CHANGE COLUMN `name` `full_name` VARCHAR(255) NOT NULL',
    );
  });

  it('MySQL 不改名时同样用 CHANGE COLUMN（旧名=新名）', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.changeColumn('users', 'name', 'name', { type: 'VARCHAR(64)' });
    expect(conn.sqls[0]).toBe('ALTER TABLE `users` CHANGE COLUMN `name` `name` VARCHAR(64)');
  });

  it('PG 拆成 RENAME + ALTER TYPE 两步', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new PostgreSqlDialect()));
    await svc.changeColumn('users', 'name', 'full_name', { type: 'text' });
    expect(conn.sqls).toEqual([
      'ALTER TABLE "users" RENAME COLUMN "name" TO "full_name"',
      'ALTER TABLE "users" ALTER COLUMN "full_name" TYPE text',
    ]);
  });

  it('PG 不改名时只发 ALTER TYPE', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new PostgreSqlDialect()));
    await svc.changeColumn('users', 'name', 'name', { type: 'text' });
    expect(conn.sqls).toEqual(['ALTER TABLE "users" ALTER COLUMN "name" TYPE text']);
  });

  it('SQLite 只能改名；仅改类型时明确报错', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new SqliteDialect()));
    await svc.changeColumn('users', 'name', 'full_name', { type: 'TEXT' });
    expect(conn.sqls[0]).toBe('ALTER TABLE "users" RENAME COLUMN "name" TO "full_name"');
    await expect(svc.changeColumn('users', 'name', 'name', { type: 'TEXT' }))
      .rejects.toThrow(/does not support altering a column type/);
  });

  it('renameColumn 生成 RENAME COLUMN', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.renameColumn('users', 'name', 'full_name', 'test');
    expect(conn.sqls[0]).toBe('ALTER TABLE `test`.`users` RENAME COLUMN `name` TO `full_name`');
  });

  it('空类型与非法标识符被拒绝', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await expect(svc.changeColumn('users', 'name', 'n2', { type: '   ' })).rejects.toThrow(/type is required/i);
    await expect(svc.renameColumn('users', 'name', 'a`b')).rejects.toThrow();
  });
});

describe('validateColumnType / 结构化 addColumn / modifyColumn', () => {
  it('接受常见合法类型', () => {
    for (const t of ['INT', 'VARCHAR(255)', 'DECIMAL(10,2)', "ENUM('a','b')", "SET('x')", 'TIMESTAMP(6) WITH TIME ZONE', 'CHARACTER SET utf8mb4', 'integer[]', 'text[][]']) {
      expect(validateColumnType(t)).toBe(t);
    }
  });

  it('拒绝注入形状：分隔符/注释/换行/引号逃逸', () => {
    for (const t of ['INT; DROP TABLE users', 'INT -- x', 'INT # x', 'INT /* x */', 'INT\nDROP', 'INT`x', 'INT"x', 'INT\\x', "VARCHAR(10", "INT)", 'INT[', 'INT]']) {
      expect(() => validateColumnType(t)).toThrow();
    }
  });

  it('addColumn 由结构化 spec 合成并转义默认值/注释', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.addColumn('users', 'age', { type: 'INT', notNull: true, defaultValue: "12'34", comment: "a'b" }, 'test');
    expect(conn.sqls[0]).toContain('ADD COLUMN `age`');
    expect(conn.sqls[0]).toContain('INT');
    expect(conn.sqls[0]).toContain("DEFAULT '12''34'");
    expect(conn.sqls[0]).toContain("COMMENT 'a''b'");
  });

  it('addColumn 拒绝注入型 type，不发出任何 SQL', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await expect(svc.addColumn('users', 'age', { type: 'INT; DROP TABLE users' }, 'test')).rejects.toThrow(/invalid characters|start with/i);
    expect(conn.sqls).toEqual([]);
  });

  it('modifyColumn 拒绝注入型 type', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await expect(svc.modifyColumn('users', 'age', { type: 'INT -- x' }, 'test')).rejects.toThrow();
    expect(conn.sqls).toEqual([]);
  });
});

describe('TableService.dropIndex 方言化', () => {
  it('MySQL 生成 ON 语法并带库限定', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.dropIndex('idx_name', 'users', 'test');
    expect(conn.sqls[0]).toBe('DROP INDEX `idx_name` ON `test`.`users`');
  });

  it('PG 生成 DROP INDEX（无 ON、不限定库）', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new PostgreSqlDialect()));
    await svc.dropIndex('idx_name', 'users', 'mydb');
    expect(conn.sqls[0]).toBe('DROP INDEX IF EXISTS "idx_name"');
  });

  it('SQLite 生成 DROP INDEX（无 ON）', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new SqliteDialect()));
    await svc.dropIndex('idx_name', 'users', 'main');
    expect(conn.sqls[0]).toBe('DROP INDEX IF EXISTS "idx_name"');
  });
});
