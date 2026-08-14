import { describe, expect, it } from 'vitest';
import { QueryService } from '../../src/query/queryService';
import { MetadataService } from '../../src/query/metadataService';
import { IConnection } from '../../src/connection/connection';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';
import type { QueryCallback } from '../../src/types/query';

class FakeConnection extends IConnection {
  public sqls: string[] = [];
  public result: any = { rows: [] };
  public fields: any[] = [];

  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }

  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    this.sqls.push(sql);
    const cb = callback || values;
    cb(null, this.result, this.fields);
  }
  connect(cb: (err: any) => void): void { cb(null); }
  beginTransaction(cb: (err: any) => void): void { cb(null); }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean { return true; }
}

describe('MetadataService', () => {
  it('getDatabases 返回数据库名列表（MySQL）', async () => {
    const conn = new FakeConnection();
    conn.result = { rows: [{ Database: 'test_db' }, { Database: 'prod_db' }] };
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const dbs = await svc.getDatabases();
    expect(dbs).toEqual(['test_db', 'prod_db']);
    expect(conn.sqls[0]).toBe('SHOW DATABASES');
  });

  it('getDatabases 返回空（SQLite）', async () => {
    const conn = new FakeConnection();
    const svc = new MetadataService(new QueryService(conn, new SqliteDialect()));
    const dbs = await svc.getDatabases();
    expect(dbs).toEqual([]);
  });

  it('getTables 解析表列表（MySQL）', async () => {
    const conn = new FakeConnection();
    conn.result = { rows: [{ name: 'users' }, { name: 'orders' }] };
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const tables = await svc.getTables('test');
    expect(tables.map((t) => t.name)).toEqual(['users', 'orders']);
  });

  it('getTables 解析表列表（PG）', async () => {
    const conn = new FakeConnection();
    conn.result = { rows: [{ name: 'users' }] };
    const svc = new MetadataService(new QueryService(conn, new PostgreSqlDialect()));
    const tables = await svc.getTables('test');
    expect(tables.map((t) => t.name)).toEqual(['users']);
  });

  it('getTables 解析表列表（SQLite）', async () => {
    const conn = new FakeConnection();
    conn.result = { rows: [{ name: 'users', type: 'table' }] };
    const svc = new MetadataService(new QueryService(conn, new SqliteDialect()));
    const tables = await svc.getTables('test');
    expect(tables.map((t) => t.name)).toEqual(['users']);
    expect(conn.sqls[0]).toContain('sqlite_master');
  });

  it('getColumns 解析列元数据（MySQL）', async () => {
    const conn = new FakeConnection();
    conn.result = {
      rows: [
        { Field: 'id', Type: 'int(11)', Key: 'PRI', Null: 'NO', Extra: 'auto_increment', Default: null },
        { Field: 'name', Type: 'varchar(255)', Key: '', Null: 'YES', Extra: '', Default: null },
      ],
    };
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const cols = await svc.getColumns('users', 'test');
    expect(cols.map((c) => c.name)).toEqual(['id', 'name']);
    expect(cols[0].isPrimary).toBe(true);
    expect(cols[0].isAutoIncrement).toBe(true);
    expect(cols[1].nullable).toBe('YES');
    expect(conn.sqls[0]).toContain('SHOW FULL COLUMNS');
  });

  it('getColumns 解析列元数据（PG）', async () => {
    const conn = new FakeConnection();
    conn.result = {
      rows: [
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
        { column_name: 'name', data_type: 'text', is_nullable: 'YES', column_default: null },
      ],
    };
    const svc = new MetadataService(new QueryService(conn, new PostgreSqlDialect()));
    const cols = await svc.getColumns('users', 'test');
    expect(cols.map((c) => c.name)).toEqual(['id', 'name']);
    expect(cols[0].nullable).toBe('NO');
    expect(conn.sqls[0]).toContain('information_schema.columns');
  });

  it('getViews 解析视图列表（MySQL）', async () => {
    const conn = new FakeConnection();
    conn.result = { rows: [{ name: 'user_view' }] };
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const views = await svc.getViews('test');
    expect(views.map((v) => v.name)).toEqual(['user_view']);
  });

  it('getFunctions 返回空（SQLite 不支持）', async () => {
    const conn = new FakeConnection();
    const svc = new MetadataService(new QueryService(conn, new SqliteDialect()));
    const funcs = await svc.getFunctions('test');
    expect(funcs).toEqual([]);
  });

  it('getEvents 返回空（PG 不支持）', async () => {
    const conn = new FakeConnection();
    const svc = new MetadataService(new QueryService(conn, new PostgreSqlDialect()));
    const events = await svc.getEvents('test');
    expect(events).toEqual([]);
  });

  it('getIndexes 解析索引列表（MySQL）', async () => {
    const conn = new FakeConnection();
    conn.result = {
      rows: [
        { name: 'PRIMARY', col: 'id', is_unique: true, is_primary: true },
        { name: 'idx_name', col: 'name', is_unique: true, is_primary: false },
      ],
    };
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const indexes = await svc.getIndexes('users', 'test');
    expect(indexes.length).toBeGreaterThanOrEqual(1);
    expect(indexes[0].isPrimary).toBe(true);
  });

  it('getForeignKeys 解析外键（MySQL）', async () => {
    const conn = new FakeConnection();
    conn.result = {
      rows: [
        { tableName: 'orders', columnName: 'user_id', refTable: 'users', refColumn: 'id', constraintName: 'fk_user' },
      ],
    };
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const fks = await svc.getForeignKeys('test');
    expect(fks[0].columnName).toBe('user_id');
    expect(fks[0].refTable).toBe('users');
  });

  it('getUsers 解析用户列表（MySQL）', async () => {
    const conn = new FakeConnection();
    conn.result = { rows: [{ name: 'root', host: 'localhost' }] };
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const users = await svc.getUsers();
    expect(users[0].name).toBe('root');
    expect(users[0].host).toBe('localhost');
  });

  /**
   * 回归：受限账号（云数据库、非 DBA）无权 SELECT mysql.user。
   * F 批用户管理面板一打开就触发全量查询，低权账号直接报错打不开。
   * 降级到 CURRENT_USER()：面板至少能打开、能对自己改密码。
   */
  it('getUsers 全量被拒时降级到当前用户', async () => {
    const conn = new (class extends FakeConnection {
      query(sql: string, callback?: QueryCallback): void;
      query(sql: string, values: any, callback?: QueryCallback): void;
      query(sql: string, values?: any, callback?: any): void {
        this.sqls.push(sql);
        const cb = callback || values;
        if (/FROM\s+mysql\.user/i.test(sql)) {
          cb(new Error("SELECT command denied to user 'dbclient'@'1.2.3.4' for table 'user'"));
          return;
        }
        // CURRENT_USER() 形如 'name'@'host'（带引号）
        cb(null, { rows: [{ ident: "'dbclient'@'101.200.138.204'" }] }, []);
      }
    })();
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const users = await svc.getUsers();
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('dbclient');
    expect(users[0].host).toBe('101.200.138.204');
    // 第二条查询应是降级的 CURRENT_USER()
    expect(conn.sqls[1]).toContain('CURRENT_USER()');
  });

  it('getUsers 降级对裸名（无 @host）也安全', async () => {
    const conn = new (class extends FakeConnection {
      query(sql: string, callback?: QueryCallback): void;
      query(sql: string, values: any, callback?: QueryCallback): void;
      query(sql: string, values?: any, callback?: any): void {
        this.sqls.push(sql);
        const cb = callback || values;
        if (/FROM\s+mysql\.user/i.test(sql)) { cb(new Error('denied')); return; }
        cb(null, { rows: [{ ident: 'appuser' }] }, []);
      }
    })();
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const users = await svc.getUsers();
    expect(users).toEqual([{ name: 'appuser', host: '%' }]);
  });

  /**
   * 权限回显：选中用户时已有权限应默认勾选，而非每次空白重选。
   */
  it('getUserGrants 解析 SHOW GRANTS 并去重、跳过 USAGE', async () => {
    const conn = new FakeConnection();
    conn.result = {
      rows: [
        { 'Grants for u@h': 'GRANT SELECT, INSERT ON `db`.* TO `u`@`h`' },
        { 'Grants for u@h': 'GRANT ALL PRIVILEGES ON *.* TO `u`@`h`' },
        { 'Grants for u@h': 'GRANT USAGE ON *.* TO `u`@`h`' },
        { 'Grants for u@h': 'GRANT SELECT ON `db`.`t` TO `u`@`h`' },
      ],
    };
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const grants = await svc.getUserGrants('u', 'h');
    expect(grants.sort()).toEqual(['ALL PRIVILEGES', 'INSERT', 'SELECT']);
  });

  it('getUserGrants 按 database 过滤（库级权限匹配，全局也算）', async () => {
    const conn = new FakeConnection();
    conn.result = {
      rows: [
        { g: 'GRANT SELECT ON `db`.* TO `u`@`h`' },
        { g: 'GRANT INSERT ON `other`.* TO `u`@`h`' },
        { g: 'GRANT ALL PRIVILEGES ON *.* TO `u`@`h`' },
      ],
    };
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const grants = await svc.getUserGrants('u', 'h', 'db');
    expect(grants.sort()).toEqual(['ALL PRIVILEGES', 'SELECT']);
  });

  it('getUserGrants 查询被拒时降级返回空', async () => {
    const conn = new (class extends FakeConnection {
      query(sql: string, callback?: QueryCallback): void;
      query(sql: string, values: any, callback?: QueryCallback): void;
      query(sql: string, values?: any, callback?: any): void {
        const cb = callback || values;
        cb(new Error('Access denied for user'));
      }
    })();
    const svc = new MetadataService(new QueryService(conn, new MysqlDialect()));
    const grants = await svc.getUserGrants('u', 'h');
    expect(grants).toEqual([]);
  });
});