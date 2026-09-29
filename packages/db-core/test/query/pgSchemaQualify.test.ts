import { describe, expect, it } from 'vitest';
import { TableService } from '../../src/query/tableService';
import { DataService } from '../../src/query/dataService';
import { MetadataService } from '../../src/query/metadataService';
import { QueryService } from '../../src/query/queryService';
import { IConnection } from '../../src/connection/connection';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import type { QueryCallback } from '../../src/types/query';

/** 内存假连接捕获 SQL（与 tableService.test.ts 同形）。 */
class Capture extends IConnection {
  public sqls: string[] = [];
  constructor() { super({ host: 'h', port: 5432, user: 'u' }); }
  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    this.sqls.push(String(sql));
    const cb = callback || values;
    cb(null, { rows: [], affectedRows: 1 }, []);
  }
  connect(cb: (e: any) => void): void { cb(null); }
  beginTransaction(cb: (e: any) => void): void { cb(null); }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean { return true; }
}

function pg() {
  const con = new Capture();
  const svc = new QueryService(con, new PostgreSqlDialect());
  return { con, svc, table: new TableService(svc), data: new DataService(svc), meta: new MetadataService(svc) };
}

/**
 * B1b：PG 多 schema 的对象操作限定。
 *
 * 未给 schema 时保持旧行为（交 search_path）；给了 schema 则所有写/DDL 都前缀
 * `"schema".`，避免落到默认 schema 的同名对象上。schema 与库名是两条通道。
 */
describe('PG schema 限定的写/DDL（B1b）', () => {
  it('dropTable 限定到 schema', async () => {
    const { con, table } = pg();
    await table.dropTable('users', 'mydb', 'sales');
    expect(con.sqls[0]).toBe('DROP TABLE "sales"."users"');
  });

  it('createTable 限定到 schema', async () => {
    const { con, table } = pg();
    await table.createTable('users', [{ name: 'id', type: 'integer', isPrimary: true }], 'mydb', 'sales');
    expect(con.sqls[0]).toContain('CREATE TABLE "sales"."users"');
  });

  it('truncate/rename/dup 与列操作均限定', async () => {
    const { con, table } = pg();
    await table.truncateTable('users', 'mydb', 'sales');
    await table.renameTable('users', 'users2', 'mydb', 'sales');
    await table.dupTable('users', 'users_copy', 'mydb', false, 'sales');
    await table.addColumn('users', 'age', { type: 'integer' }, 'mydb', 'sales');
    await table.renameColumn('users', 'age', 'age2', 'mydb', 'sales');
    const sql = con.sqls.join('\n');
    expect(sql).toContain('TRUNCATE TABLE "sales"."users"');
    expect(sql).toContain('ALTER TABLE "sales"."users" RENAME TO "users2"');
    expect(sql).toContain('CREATE TABLE "sales"."users_copy" (LIKE "sales"."users" INCLUDING ALL)');
    expect(sql).toContain('ALTER TABLE "sales"."users" ADD COLUMN "age" integer');
    expect(sql).toContain('ALTER TABLE "sales"."users" RENAME COLUMN "age" TO "age2"');
  });

  it('dropIndex 限定索引所在 schema', async () => {
    const { con, table } = pg();
    await table.dropIndex('idx_x', 'users', 'mydb', 'sales');
    expect(con.sqls[0]).toBe('DROP INDEX IF EXISTS "sales"."idx_x"');
  });

  it('createIndex 限定目标表', async () => {
    const { con, table } = pg();
    await table.createIndex('idx_users_name', 'users', ['name'], 'mydb', false, 'sales');
    expect(con.sqls[0]).toBe('CREATE INDEX "idx_users_name" ON "sales"."users" ("name")');
  });

  it('外键增删限定目标表', async () => {
    const { con, table, meta } = pg();
    await table.dropForeignKey('fk_x', 'users', 'mydb', 'sales');
    expect(con.sqls[0]).toBe('ALTER TABLE "sales"."users" DROP CONSTRAINT "fk_x"');
    const sql = meta.createForeignKeySql('fk_x', 'users', ['dept_id'], 'dept', ['id'], 'mydb', 'sales');
    expect(sql).toContain('ALTER TABLE "sales"."users"');
    expect(sql).toContain('REFERENCES "sales"."dept"');
  });

  it('触发器删除限定目标表', () => {
    const { meta } = pg();
    expect(meta.dropTriggerSql('trg', 'users', 'mydb', 'sales'))
      .toBe('DROP TRIGGER IF EXISTS "trg" ON "sales"."users"');
  });

  it('视图修改语句与导出 INSERT 限定 schema', () => {
    const dialect = new PostgreSqlDialect();
    expect(dialect.normalizeViewAlterSql('SELECT 1', 'v', undefined, 'sales'))
      .toBe('CREATE OR REPLACE VIEW "sales"."v" AS\nSELECT 1;');
    expect(dialect.buildInsertSql([{ a: 1 }], ['a'], 't', 'mydb', 'sales'))
      .toBe('INSERT INTO "sales"."t" ("a") VALUES (1);\n');
  });

  it('未给 schema 时保持旧行为（交 search_path）', async () => {
    const { con, table } = pg();
    await table.dropTable('users', 'mydb');
    expect(con.sqls[0]).toBe('DROP TABLE "users"');
  });

  it('schema 名为注入形状时拒绝，不发任何 SQL', async () => {
    const { con, table } = pg();
    await expect(table.dropTable('users', 'mydb', "sa'; DROP TABLE x; --")).rejects.toThrow();
    expect(con.sqls).toEqual([]);
  });
});

describe('PG schema 限定的数据编辑（B1b）', () => {
  it('updateCell / insertRow / deleteRows 限定 schema', async () => {
    const { con, data } = pg();
    await data.updateCell('users', ['id'], [5], 'name', 'x', 'mydb', 'sales');
    await data.insertRow('users', ['name'], ['x'], 'mydb', 'sales');
    await data.deleteRows('users', ['id'], [[5]], 'mydb', 'sales');
    expect(con.sqls[0]).toBe('UPDATE "sales"."users" SET "name" = \'x\' WHERE "id" = 5');
    expect(con.sqls[1]).toBe('INSERT INTO "sales"."users" ("name") VALUES (\'x\')');
    expect(con.sqls[2]).toBe('DELETE FROM "sales"."users" WHERE ("id" = 5)');
  });

  it('未给 schema 时不限定（回归）', async () => {
    const { con, data } = pg();
    await data.updateCell('users', ['id'], [5], 'name', 'x', 'mydb');
    expect(con.sqls[0]).toBe('UPDATE "users" SET "name" = \'x\' WHERE "id" = 5');
  });
});

describe('MySQL 不受 schema 通道影响（回归）', () => {
  it('库限定仍走 database 槽，忽略 schema 形参', async () => {
    const con = new Capture();
    const table = new TableService(new QueryService(con, new MysqlDialect()));
    await table.dropTable('users', 'mydb', 'ignored');
    expect(con.sqls[0]).toBe('DROP TABLE `mydb`.`users`');
  });
});