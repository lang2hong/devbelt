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
    expect(new PostgreSqlDialect().capabilities.operations).toContain('schemaSync');
    // B2：PG 也可浏览全部库（每库懒建会话）。
    expect(new PostgreSqlDialect().capabilities.multiDatabaseExplorer).toBe(true);
    expect(new MysqlDialect().capabilities.multiDatabaseExplorer).toBe(true);
    expect(new SqliteDialect().capabilities.events).toBe(false);
    expect(new SqliteDialect().capabilities.operations).not.toContain('truncateTable');
  });

  it('B1：schema 层能力只有 PG 开启，且 PG 提供 getSchemaListSql', () => {
    expect(new PostgreSqlDialect().capabilities.schemas).toBe(true);
    expect(new MysqlDialect().capabilities.schemas).toBe(false);
    expect(new SqliteDialect().capabilities.schemas).toBe(false);
    const schemaSql = new PostgreSqlDialect().getSchemaListSql();
    expect(schemaSql).toContain('pg_namespace');
    // A2：不再用 `NOT LIKE 'pg\_%'`（scs=off 语义漂移），改用 left()。
    expect(schemaSql).toContain("left(nspname, 3) <> 'pg_'");
    expect(schemaSql).not.toContain('pg\\_%');
    // A6：不再做字符白名单预过滤（改用 validateSchemaIdent + 引用层防注入），
    // 否则含空格/`.`/`"` 的合法 schema 列不出来、无法操作；仅保留系统/USAGE 过滤。
    expect(schemaSql).not.toContain('[[:alpha:]_$]');
    expect(schemaSql).not.toContain("NOT LIKE '%--%'");
    expect(schemaSql).toContain("has_schema_privilege(nspname, 'USAGE')");
    expect((new MysqlDialect() as { getSchemaListSql?: unknown }).getSchemaListSql).toBeUndefined();
  });

  it('B2：PG 库列表只含有 CONNECT 权限的非模板库', () => {
    const sql = new PostgreSqlDialect().getDatabaseListSql();
    expect(sql).toContain("has_database_privilege(datname, 'CONNECT')");
    expect(sql).toContain('datistemplate = false');
  });

  it('M1：PG 视图定义按 relkind/oid（不拼接未加引号的名字）', () => {
    const sql = new PostgreSqlDialect().getViewDefinitionSql('PublicOrders', undefined, 'sales');
    expect(sql).toContain('pg_get_viewdef(c.oid, true)');
    expect(sql).toContain("c.relkind = 'v'");
    expect(sql).toContain("n.nspname = 'sales'");
    // 旧写法会拼接 `'s' || '.' || 'V'`
    expect(sql).not.toContain("|| '.' ||");
    // A6：注入形状的 schema 不再被拒，而是作为**字符串字面量**安全转义（单引号翻倍），不逃出上下文。
    expect(new PostgreSqlDialect().getViewDefinitionSql('v', undefined, "x'; DROP"))
      .toContain("n.nspname = 'x''; DROP'");
  });

  it('B1：PG 元数据 SQL 按 schema 限定，注入形状被安全转义', () => {
    const pg = new PostgreSqlDialect();
    expect(pg.getTableListSql(undefined, 'myschema')).toContain("n.nspname = 'myschema'");
    expect(pg.getTableListSql(undefined, undefined)).toContain('current_schema()');
    expect(pg.getColumnsSql('t', undefined, 'myschema')).toContain("c.table_schema = 'myschema'");
    // A6：含引号/分号的 schema 作为字符串字面量安全转义（单引号翻倍），不再靠白名单拒绝。
    expect(pg.getTableListSql(undefined, "x'; DROP TABLE t; --"))
      .toContain("n.nspname = 'x''; DROP TABLE t; --'");
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

    it('PostgreSQL 用双引号且不限定库名（database 是库名不是 schema），不转义反斜杠', () => {
      const sql = new PostgreSqlDialect().buildInsertSql(rows, columns, 'users', 'public');
      expect(sql).toContain('INSERT INTO "users" ("id", "name", "bio", "score", "flag")');
      expect(sql).not.toContain('"public".');
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

    it('PostgreSQL normalizeViewAlterSql 不限定库名', () => {
      const sql = new PostgreSqlDialect().normalizeViewAlterSql('SELECT 1', 'v', 'mydb');
      expect(sql).toContain('CREATE OR REPLACE VIEW "v" AS');
      expect(sql).not.toContain('"mydb".');
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

    it('B1b：PG 触发器定义按 schema + 表限定（避免同名触发器串表）', () => {
      const d = new PostgreSqlDialect();
      const sql = d.getTriggerDefinitionSql('trg', undefined, 'sales', 'orders');
      expect(sql).toContain("n.nspname = 'sales'");
      expect(sql).toContain("c.relname = 'orders'");
      expect(sql).toContain('NOT t.tgisinternal');
      // A6：注入形状 schema 安全转义（字面量单引号翻倍）。
      expect(d.getTriggerDefinitionSql('trg', undefined, "x'; DROP", 'orders'))
        .toContain("n.nspname = 'x''; DROP'");
    });

    it('B1b：PG 外键查询按 constraint_schema 关联并返回 refSchema', () => {
      const d = new PostgreSqlDialect();
      const sql = d.getForeignKeysSql(undefined, 'sales');
      expect(sql).toContain('tc.constraint_schema = kcu.constraint_schema');
      expect(sql).toContain('tc.constraint_schema = ccu.constraint_schema');
      expect(sql).toContain('ccu.table_schema AS "refSchema"');
      expect(d.parseForeignKeys([{ refTable: 'dept', refSchema: 'sales' }])[0].refSchema).toBe('sales');
    });

    it('B1b：PG 创建外键可跨 schema 指向 refSchema', () => {
      const d = new PostgreSqlDialect();
      const sql = d.createForeignKeySql('fk', 'orders', ['dept_id'], 'dept', ['id'], undefined, 'sales', 'hr');
      expect(sql).toContain('ALTER TABLE "sales"."orders"');
      expect(sql).toContain('REFERENCES "hr"."dept"');
    });

    it('MySQL 表/视图列表带 ORDER BY TABLE_NAME（排序稳定）', () => {
      const d = new MysqlDialect();
      expect(d.getTableListSql('app')).toContain('ORDER BY TABLE_NAME');
      expect(d.getTableListSql()).toContain('ORDER BY TABLE_NAME');
      expect(d.getViewListSql('app')).toContain('ORDER BY TABLE_NAME');
      expect(d.getViewListSql()).toContain('ORDER BY TABLE_NAME');
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

describe('方言模板（加列 / 改列）', () => {
  /** 回归：加列/改列 SQL 入口的模板必须按方言给，不能统一塞 MySQL 语法。 */
  it('新增列模板按方言给出类型与包裹', () => {
    expect(new MysqlDialect().addColumnTemplate('`t`')).toBe('ALTER TABLE `t` ADD COLUMN `new_column` INT;');
    expect(new PostgreSqlDialect().addColumnTemplate('"t"')).toBe('ALTER TABLE "t" ADD COLUMN "new_column" INTEGER;');
    expect(new SqliteDialect().addColumnTemplate('"t"')).toContain('ADD COLUMN "new_column"');
  });

  it('改列模板：MySQL MODIFY、PG ALTER TYPE、SQLite 仅改名', () => {
    expect(new MysqlDialect().modifyColumnTemplate('`t`', 'age', 'INT NOT NULL')).toBe(
      'ALTER TABLE `t` MODIFY COLUMN `age` INT NOT NULL;',
    );
    expect(new PostgreSqlDialect().modifyColumnTemplate('"t"', 'age', 'INTEGER')).toBe(
      'ALTER TABLE "t" ALTER COLUMN "age" TYPE INTEGER;',
    );
    const sqlite = new SqliteDialect().modifyColumnTemplate('"t"', 'age', 'INTEGER');
    expect(sqlite).toContain('RENAME COLUMN "age" TO "age"');
    expect(sqlite).not.toContain('TYPE INTEGER');
  });

  it('方言注册表取到的实例带加列/改列模板方法', () => {
    for (const dbType of [DatabaseType.MYSQL, DatabaseType.PG, DatabaseType.SQLITE]) {
      const d = DialectRegistry.get(dbType)!;
      expect(typeof d.addColumnTemplate).toBe('function');
      expect(typeof d.modifyColumnTemplate).toBe('function');
    }
  });
});
describe('getKeysetSql（keyset 深分页）', () => {
  it('MySQL：首页仅 ORDER BY，续页展开为标量比较（兼容复合主键）', () => {
    const d = new MysqlDialect();
    expect(d.getKeysetSql('SELECT * FROM `t`', ['id'], undefined, 100))
      .toBe('SELECT * FROM `t` ORDER BY `id` LIMIT 100');
    expect(d.getKeysetSql('SELECT * FROM `t`', ['id'], [42], 100))
      .toBe('SELECT * FROM `t` WHERE (`id` > 42) ORDER BY `id` LIMIT 100');
  });

  it('MySQL：复合主键展开为 (a>v1) OR (a=v1 AND b>v2)，不使用行值构造器', () => {
    const d = new MysqlDialect();
    expect(d.getKeysetSql('SELECT * FROM `t`', ['a', 'b'], [1, "x'y"], 50))
      .toBe("SELECT * FROM `t` WHERE (`a` > 1) OR (`a` = 1 AND `b` > 'x''y') ORDER BY `a`, `b` LIMIT 50");
  });

  it('PG：复合主键同样展开 + 值转义', () => {
    const d = new PostgreSqlDialect();
    expect(d.getKeysetSql('SELECT * FROM "t"', ['a', 'b'], [1, "x'y"], 50))
      .toBe(`SELECT * FROM "t" WHERE ("a" > 1) OR ("a" = 1 AND "b" > 'x''y') ORDER BY "a", "b" LIMIT 50`);
  });

  it('SQLite：首页与续页', () => {
    const d = new SqliteDialect();
    expect(d.getKeysetSql('SELECT * FROM "t"', ['id'], [7], 10))
      .toBe('SELECT * FROM "t" WHERE ("id" > 7) ORDER BY "id" LIMIT 10');
  });

  it('非法 limit / afterValues 长度不符时抛错', () => {
    const d = new MysqlDialect();
    expect(() => d.getKeysetSql('SELECT * FROM `t`', ['id'], undefined, 0)).toThrow(/positive integer/);
    expect(() => d.getKeysetSql('SELECT * FROM `t`', ['id'], [1, 2], 10)).toThrow(/length/);
  });
});

describe('PG 主键探测 / keyset 游标 NULL 防护', () => {
  it('PG getColumnsSql 通过 information_schema 约束输出 key=PRI（根因：过去恒为空）', () => {
    const sql = new PostgreSqlDialect().getColumnsSql('users');
    expect(sql).toContain('PRIMARY KEY');
    expect(sql).toContain("THEN 'PRI'");
    expect(sql).toContain('information_schema.table_constraints');
  });

  it('keyset afterValues 含 null/undefined 时 fail-closed 抛错', () => {
    const d = new MysqlDialect();
    expect(() => d.getKeysetSql('SELECT * FROM `t`', ['id'], [null], 10)).toThrow(/null/);
    expect(() => d.getKeysetSql('SELECT * FROM `t`', ['id'], [undefined], 10)).toThrow(/null/);
  });
});
