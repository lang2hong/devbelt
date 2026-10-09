import { describe, expect, it } from 'vitest';
import { SchemaDiffService } from '../../src/query/schemaDiffService';
import type { MetadataService } from '../../src/query/metadataService';
import type { TableService } from '../../src/query/tableService';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';
import { DatabaseType } from '../../src/types/connection';
import { normalizeColumnMeta } from '../../src/query/normalize';
import { QueryService } from '../../src/query/queryService';
import { IConnection } from '../../src/connection/connection';
import type { QueryCallback } from '../../src/types/query';

class FakeConnection extends IConnection {
  public sqls: string[] = [];
  public result: any = { rows: [] };
  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }
  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    this.sqls.push(sql);
    const cb = callback || values;
    cb(null, this.result, []);
  }
  connect(cb: (err: any) => void): void { cb(null); }
  beginTransaction(cb: (err: any) => void): void { cb(null); }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean { return true; }
}

function mockMetaService(tables: string[], columnsMap: Record<string, { name: string; type: string }[]>): MetadataService {
  return {
    getTables: async () => tables.map((name) => ({ name })),
    getColumns: async (table: string) => columnsMap[table] || [],
  } as unknown as MetadataService;
}

describe('SchemaDiffService', () => {
  it('发现新增表', async () => {
    const source = mockMetaService(['users', 'orders'], {});
    const target = mockMetaService(['users'], {});
    const diffs = await SchemaDiffService.diff(source, 'sourceDb', target, 'targetDb');
    const added = diffs.filter((d) => d.status === 'added');
    expect(added.map((d) => d.tableName)).toEqual(['orders']);
  });

  it('发现删除表', async () => {
    const source = mockMetaService(['users'], {});
    const target = mockMetaService(['users', 'orders'], {});
    const diffs = await SchemaDiffService.diff(source, 'sourceDb', target, 'targetDb');
    const removed = diffs.filter((d) => d.status === 'removed');
    expect(removed.map((d) => d.tableName)).toEqual(['orders']);
  });

  it('发现列变更', async () => {
    const source = mockMetaService(
      ['users'],
      { users: [{ name: 'id', type: 'int(11)' }, { name: 'email', type: 'varchar(255)' }] },
    );
    const target = mockMetaService(
      ['users'],
      { users: [{ name: 'id', type: 'int(11)' }, { name: 'email', type: 'varchar(100)' }] },
    );
    const diffs = await SchemaDiffService.diff(source, 'sourceDb', target, 'targetDb');
    const users = diffs.find((d) => d.tableName === 'users')!;
    expect(users.status).toBe('changed');
    const changed = users.columns.filter((c) => c.status === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].columnName).toBe('email');
    expect(changed[0].sourceType).toBe('varchar(255)');
    expect(changed[0].targetType).toBe('varchar(100)');
  });

  it('仅 NOT NULL 变化也算 changed，并带出 sourceNotNull', async () => {
    const source = mockMetaService(['users'], { users: [{ name: 'id', type: 'int(11)', isNotNull: true } as any] });
    const target = mockMetaService(['users'], { users: [{ name: 'id', type: 'int(11)', isNotNull: false } as any] });
    const diffs = await SchemaDiffService.diff(source, 'sourceDb', target, 'targetDb');
    const users = diffs.find((d) => d.tableName === 'users')!;
    expect(users.status).toBe('changed');
    const id = users.columns.find((c) => c.columnName === 'id')!;
    expect(id.status).toBe('changed');
    expect(id.sourceNotNull).toBe(true);
  });

  it('发现新增列和删除列', async () => {
    const source = mockMetaService(
      ['users'],
      { users: [{ name: 'id', type: 'int(11)' }, { name: 'name', type: 'varchar(255)' }] },
    );
    const target = mockMetaService(
      ['users'],
      { users: [{ name: 'id', type: 'int(11)' }, { name: 'age', type: 'int(11)' }] },
    );
    const diffs = await SchemaDiffService.diff(source, 'sourceDb', target, 'targetDb');
    const users = diffs.find((d) => d.tableName === 'users')!;
    const added = users.columns.filter((c) => c.status === 'added');
    const removed = users.columns.filter((c) => c.status === 'removed');
    expect(added.map((c) => c.columnName)).toEqual(['name']);
    expect(removed.map((c) => c.columnName)).toEqual(['age']);
  });

  it('无差异时表状态为 unchanged', async () => {
    const source = mockMetaService(
      ['users'],
      { users: [{ name: 'id', type: 'int(11)' }] },
    );
    const target = mockMetaService(
      ['users'],
      { users: [{ name: 'id', type: 'int(11)' }] },
    );
    const diffs = await SchemaDiffService.diff(source, 'sourceDb', target, 'targetDb');
    const users = diffs.find((d) => d.tableName === 'users')!;
    expect(users.status).toBe('unchanged');
  });

  it('generateSyncSql 生成同步 SQL（MySQL）', async () => {
    const conn = new FakeConnection();
    conn.result = { rows: [{ 'Create Table': 'CREATE TABLE `users` (\n  `id` int(11) NOT NULL\n) ENGINE=InnoDB' }] };
    const svc = new QueryService(conn, new MysqlDialect());
    const tableService = {
      getCreateSql: async (table: string) => {
        const r = await svc.query(`SHOW CREATE TABLE \`${table}\``);
        return (r.rows[0] as any)['Create Table'];
      },
      supports: () => true,
      require: () => {},
    } as unknown as TableService;
    const diffs = [{ tableName: 'orders', status: 'added' as const, columns: [] }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain('-- Schema sync');
    expect(sql).toContain('DROP TABLE IF EXISTS');
    expect(sql).toContain('CREATE TABLE');
  });

  it('generateSyncSql 只给表名加库前缀，列名不带前缀', async () => {
    const ddl = 'CREATE TABLE `users` (\n  `id` int(11) NOT NULL,\n  `name` varchar(255) DEFAULT NULL\n) ENGINE=InnoDB';
    const tableService = {
      getCreateSql: async () => ddl,
      supports: () => true,
      require: () => {},
    } as unknown as TableService;
    const diffs = [{ tableName: 'users', status: 'added' as const, columns: [] }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain('CREATE TABLE `targetDb`.`users`');
    expect(sql).toContain('`id` int(11) NOT NULL');
    expect(sql).toContain('`name` varchar(255) DEFAULT NULL');
    expect(sql).not.toContain('`targetDb`.`id`');
    expect(sql).not.toContain('`targetDb`.`name`');
  });

  it('generateSyncSql：目标 MySQL NO_BACKSLASH_ESCAPES 时默认值/注释不再翻倍反斜杠', async () => {
    const tableService = {
      getCreateSql: async () => '',
      supports: () => true,
      require: () => {},
    } as unknown as TableService;
    const diffs = [{
      tableName: 'users',
      status: 'changed' as const,
      columns: [{
        columnName: 'path',
        status: 'added' as const,
        sourceType: 'varchar(255)',
        sourceDefault: 'C:\\tmp',
        sourceComment: "it's a path",
      }],
    }];

    const dflt = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    const nbe = await SchemaDiffService.generateSyncSql(
      diffs, 'targetDb', tableService, 'sourceDb', new MysqlDialect({ noBackslashEscapes: true }),
    );

    // 默认模式：反斜杠翻倍
    expect(dflt).toContain("DEFAULT 'C:\\\\tmp'");
    // NO_BACKSLASH_ESCAPES：反斜杠原样
    expect(nbe).toContain("DEFAULT 'C:\\tmp'");
    expect(nbe).not.toContain('C:\\\\tmp');
    // 单引号两种模式都必须翻倍
    expect(dflt).toContain("COMMENT 'it''s a path'");
    expect(nbe).toContain("COMMENT 'it''s a path'");
  });

  it('generateSyncSql 拒绝含反引号的库名/表名（SQL 注入防线）', async () => {
    const tableService = {
      getCreateSql: async () => '',
      supports: () => true,
      require: () => {},
    } as unknown as TableService;
    await expect(
      SchemaDiffService.generateSyncSql([], '`evil`', tableService, 'sourceDb'),
    ).rejects.toThrow('Invalid SQL identifier');
    await expect(
      SchemaDiffService.generateSyncSql(
        [{ tableName: 'a`; DROP TABLE x; --', status: 'removed' as const, columns: [] }],
        'targetDb',
        tableService,
        'sourceDb',
      ),
    ).rejects.toThrow('Invalid SQL identifier');
  });

  it('generateSyncSql 生成 PG DDL（双引号、ALTER COLUMN TYPE、SET/DROP NOT NULL）', async () => {
    const pg = new PostgreSqlDialect();
    const tableService = {
      dbType: DatabaseType.PG,
      wrapIdentifier: (id: string) => pg.wrap(id),
      getCreateSql: async () => 'CREATE TABLE "users" (\n  "id" integer NOT NULL\n)',
      supports: () => true,
    } as unknown as TableService;
    const diffs = [{
      tableName: 'users',
      status: 'changed' as const,
      columns: [
        { columnName: 'name', status: 'changed' as const, sourceType: 'character varying(255)', sourceNotNull: true },
        { columnName: 'age', status: 'added' as const, sourceType: 'integer' },
        { columnName: 'old', status: 'removed' as const },
      ],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain('ALTER TABLE "users"');
    expect(sql).toContain('ALTER COLUMN "name" TYPE character varying(255)');
    expect(sql).toContain('ALTER COLUMN "name" SET NOT NULL');
    expect(sql).toContain('ADD COLUMN "age" integer');
    expect(sql).toContain('DROP COLUMN "old"');
    expect(sql).not.toContain('MODIFY COLUMN');
    expect(sql).not.toContain('`');
  });

  it('PG 仅长度/精度变化：发出 ALTER COLUMN TYPE（此前被 base() 漏发）', async () => {
    const pg = new PostgreSqlDialect();
    const tableService = {
      dbType: DatabaseType.PG,
      wrapIdentifier: (id: string) => pg.wrap(id),
      getCreateSql: async () => '',
      supports: () => true,
    } as unknown as TableService;
    const diffs = [{
      tableName: 'users',
      status: 'changed' as const,
      columns: [
        { columnName: 'name', status: 'changed' as const, sourceType: 'character varying(255)', targetType: 'character varying(100)', sourceNotNull: false, targetNotNull: false },
      ],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain('ALTER COLUMN "name" TYPE character varying(255)');
    expect(sql).not.toContain('No differences found');
    // 仅长度变化不触发 USING 告警
    expect(sql).not.toContain('may require USING');
  });

  it('默认值/注释变化被判为 changed 并带出目标值', async () => {
    const source = mockMetaService(['users'], { users: [{ name: 'flag', type: 'boolean', defaultValue: 'true', comment: 'c1' } as any] });
    const target = mockMetaService(['users'], { users: [{ name: 'flag', type: 'boolean', defaultValue: 'false', comment: 'c2' } as any] });
    const diffs = await SchemaDiffService.diff(source, 's', target, 't');
    const flag = diffs.find((d) => d.tableName === 'users')!.columns.find((c) => c.columnName === 'flag')!;
    expect(flag.status).toBe('changed');
    expect(flag.targetDefault).toBe('false');
    expect(flag.targetComment).toBe('c2');
  });

  it('PG 仅默认值变化：SET/DROP DEFAULT（类型/约束相同不重发）', async () => {
    const pg = new PostgreSqlDialect();
    const tableService = {
      dbType: DatabaseType.PG,
      wrapIdentifier: (id: string) => pg.wrap(id),
      getCreateSql: async () => '',
      supports: () => true,
    } as unknown as TableService;
    const diffs = [{
      tableName: 'users',
      status: 'changed' as const,
      columns: [
        { columnName: 'flag', status: 'changed' as const, sourceType: 'boolean', targetType: 'boolean', sourceNotNull: false, targetNotNull: false, sourceDefault: 'true', targetDefault: 'false' },
        { columnName: 'note', status: 'changed' as const, sourceType: 'text', targetType: 'text', sourceNotNull: false, targetNotNull: false, sourceDefault: undefined, targetDefault: "'x'" },
      ],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain('ALTER COLUMN "flag" SET DEFAULT true');
    expect(sql).toContain('ALTER COLUMN "note" DROP DEFAULT');
    expect(sql).not.toContain('ALTER COLUMN "flag" TYPE');
    expect(sql).not.toContain('ALTER COLUMN "flag" SET NOT NULL');
  });

  it('PG 仅注释变化：COMMENT ON COLUMN 独立语句（不并入 ALTER TABLE）', async () => {
    const pg = new PostgreSqlDialect();
    const tableService = {
      dbType: DatabaseType.PG,
      wrapIdentifier: (id: string) => pg.wrap(id),
      getCreateSql: async () => '',
      supports: () => true,
    } as unknown as TableService;
    const diffs = [{
      tableName: 'users',
      status: 'changed' as const,
      columns: [
        { columnName: 'name', status: 'changed' as const, sourceType: 'text', targetType: 'text', sourceNotNull: false, targetNotNull: false, sourceComment: "it's", targetComment: 'old' },
      ],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain(`COMMENT ON COLUMN "users"."name" IS 'it''s';`);
    expect(sql).not.toContain('ALTER TABLE "users" ');
  });

  it('MySQL 仅默认值变化：MODIFY COLUMN 全量重渲染（带 DEFAULT）', async () => {
    const tableService = { getCreateSql: async () => '', supports: () => true, require: () => {} } as unknown as TableService;
    const diffs = [{
      tableName: 'users',
      status: 'changed' as const,
      columns: [{ columnName: 'flag', status: 'changed' as const, sourceType: 'tinyint(1)', sourceNotNull: false, sourceDefault: '1' }],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain('MODIFY COLUMN `flag`');
    expect(sql).toContain('DEFAULT');
  });

  it('SQLite 默认值变化：仅提示重建，不发不可执行 DDL', async () => {
    const sq = new SqliteDialect();
    const tableService = {
      dbType: DatabaseType.SQLITE,
      wrapIdentifier: (id: string) => sq.wrap(id),
      getCreateSql: async () => '',
      supports: () => true,
    } as unknown as TableService;
    const diffs = [{
      tableName: 't',
      status: 'changed' as const,
      columns: [{ columnName: 'a', status: 'changed' as const, sourceType: 'INTEGER', targetType: 'INTEGER', sourceNotNull: false, targetNotNull: false, sourceDefault: '1', targetDefault: '2' }],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 't2', tableService, 's');
    expect(sql).toContain('table rebuild required');
    expect(sql).toContain('DEFAULT');
    expect(sql).not.toContain('ALTER TABLE "t" ALTER');
  });

  it('generateSyncSql 生成 SQLite DDL（ADD/DROP COLUMN，改类型仅注释）', async () => {
    const sq = new SqliteDialect();
    const tableService = {
      dbType: DatabaseType.SQLITE,
      wrapIdentifier: (id: string) => sq.wrap(id),
      getCreateSql: async () => 'CREATE TABLE "t" ("id" INTEGER)',
      supports: () => true,
    } as unknown as TableService;
    const diffs = [{
      tableName: 't',
      status: 'changed' as const,
      columns: [
        { columnName: 'a', status: 'added' as const, sourceType: 'TEXT' },
        { columnName: 'b', status: 'removed' as const },
        { columnName: 'c', status: 'changed' as const, sourceType: 'INTEGER', targetType: 'TEXT' },
      ],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 't2', tableService, 's');
    expect(sql).toContain('ALTER TABLE "t" ADD COLUMN "a" TEXT;');
    expect(sql).toContain('ALTER TABLE "t" DROP COLUMN "b";');
    expect(sql).toContain('table rebuild required');
    expect(sql).not.toContain('MODIFY COLUMN');
  });

  it('generateSyncSql 无差异时输出提示', async () => {
    const tableService = {
      getCreateSql: async () => '',
      supports: () => true,
      require: () => {},
    } as unknown as TableService;
    const sql = await SchemaDiffService.generateSyncSql([], 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain('No differences found');
  });

  it('generateSyncSql 不支持 schemaSync 时抛错', async () => {
    const tableService = {
      supports: () => false,
      require: () => { throw new Error('unsupported'); },
    } as unknown as TableService;
    await expect(
      SchemaDiffService.generateSyncSql([], 'targetDb', tableService, 'sourceDb'),
    ).rejects.toThrow();
  });

  it('新增 NOT NULL 列带默认值：DDL 带 DEFAULT', async () => {
    const tableService = { getCreateSql: async () => '', supports: () => true, require: () => {} } as unknown as TableService;
    const diffs = [{
      tableName: 'users',
      status: 'changed' as const,
      columns: [{ columnName: 'age', status: 'added' as const, sourceType: 'int(11)', sourceNotNull: true, sourceDefault: '18' }],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain('ADD COLUMN `age` int(11) NOT NULL DEFAULT 18');
  });

  it('新增 NOT NULL 列无默认值：降级为可空并告警，不发出不可执行 DDL', async () => {
    const tableService = { getCreateSql: async () => '', supports: () => true, require: () => {} } as unknown as TableService;
    const diffs = [{
      tableName: 'users',
      status: 'changed' as const,
      columns: [{ columnName: 'age', status: 'added' as const, sourceType: 'int(11)', sourceNotNull: true }],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain('ADD COLUMN `age` int(11)');
    expect(sql).not.toContain('`age` int(11) NOT NULL');
    expect(sql).toContain('WARN');
  });

  it('MODIFY COLUMN 保留默认值/注释等属性，不再静默丢弃', async () => {
    const tableService = { getCreateSql: async () => '', supports: () => true, require: () => {} } as unknown as TableService;
    const diffs = [{
      tableName: 'users',
      status: 'changed' as const,
      columns: [{
        columnName: 'email', status: 'changed' as const,
        sourceType: 'varchar(255)', targetType: 'varchar(100)',
        sourceNotNull: true, sourceDefault: 'x', sourceComment: 'c',
      }],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 'sourceDb');
    expect(sql).toContain("MODIFY COLUMN `email` varchar(255) NOT NULL DEFAULT 'x' COMMENT 'c'");
  });

  it('PG 新增列默认值原样透传（表达式不做字符串转义）', async () => {
    const pg = new PostgreSqlDialect();
    const tableService = {
      dbType: DatabaseType.PG,
      wrapIdentifier: (id: string) => pg.wrap(id),
      getCreateSql: async () => '',
      supports: () => true,
    } as unknown as TableService;
    const diffs = [{
      tableName: 't',
      status: 'changed' as const,
      columns: [
        { columnName: 'x', status: 'added' as const, sourceType: 'text', sourceDefault: "'x'::character varying" },
        { columnName: 'id', status: 'added' as const, sourceType: 'integer', sourceDefault: "nextval('t_id_seq'::regclass)" },
      ],
    }];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'targetDb', tableService, 's');
    expect(sql).toContain("ADD COLUMN \"x\" text DEFAULT 'x'::character varying");
    expect(sql).toContain("ADD COLUMN \"id\" integer DEFAULT nextval('t_id_seq'::regclass)");
    expect(sql).not.toContain("''x''::character varying");
  });

  it('normalizeColumnMeta 识别 SQLite PRAGMA 的 notnull/dflt_value', () => {
    const col = normalizeColumnMeta({ name: 'id', type: 'INTEGER', notnull: 1, dflt_value: '0' } as any);
    expect(col.isNotNull).toBe(true);
    expect(col.defaultValue).toBe('0');
    const nullable = normalizeColumnMeta({ name: 'n', type: 'TEXT', notnull: 0 } as any);
    expect(nullable.isNotNull).toBe(false);
  });

  it('PG 跨 schema 对比：schema 透传给 getTables/getColumns（不再只比 current_schema）', async () => {
    const calls: unknown[][] = [];
    const src = {
      getTables: async (db?: string, schema?: string) => { calls.push(['tables', db, schema]); return [{ name: 'users' }]; },
      getColumns: async (t: string, db?: string, schema?: string) => { calls.push(['cols', t, db, schema]); return [{ name: 'id', type: 'integer' }]; },
    } as unknown as MetadataService;
    const tgt = {
      getTables: async () => [{ name: 'users' }],
      getColumns: async () => [{ name: 'id', type: 'integer' }],
    } as unknown as MetadataService;
    await SchemaDiffService.diff(src, 'mydb', tgt, 'mydb', 'sales', 'staging');
    expect(calls).toEqual(expect.arrayContaining([
      ['tables', 'mydb', 'sales'],
      ['cols', 'users', 'mydb', 'sales'],
    ]));
  });

  it('PG 同步 SQL：targetSchema 限定目标 schema，且把源 DDL 的限定名改写到目标', async () => {
    const pg = new PostgreSqlDialect();
    const tableService = {
      dbType: DatabaseType.PG,
      wrapIdentifier: (id: string) => pg.wrap(id),
      getCreateSql: async (_t: string, _db?: string, schema?: string) =>
        `CREATE TABLE ${pg.wrap(String(schema))}.${pg.wrap('orders')} (\n  "id" integer NOT NULL\n)`,
      supports: () => true,
    } as unknown as TableService;
    const diffs = [
      { tableName: 'orders', status: 'added' as const, columns: [] },
      {
        tableName: 'users',
        status: 'changed' as const,
        columns: [{ columnName: 'name', status: 'changed' as const, sourceType: 'text', targetType: 'text', sourceNotNull: true, targetNotNull: false }],
      },
    ];
    const sql = await SchemaDiffService.generateSyncSql(diffs, 'mydb', tableService, 'mydb', undefined, { sourceSchema: 'sales', targetSchema: 'staging' });
    expect(sql).toContain('CREATE TABLE "staging"."orders"');
    expect(sql).not.toContain('"sales"."orders"');
    expect(sql).toContain('DROP TABLE IF EXISTS "staging"."orders"');
    expect(sql).toContain('ALTER TABLE "staging"."users"');
    expect(sql).toContain('ALTER COLUMN "name" SET NOT NULL');
  });
});