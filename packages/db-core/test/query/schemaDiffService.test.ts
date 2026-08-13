import { describe, expect, it } from 'vitest';
import { SchemaDiffService } from '../../src/query/schemaDiffService';
import type { MetadataService } from '../../src/query/metadataService';
import type { TableService } from '../../src/query/tableService';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
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
});