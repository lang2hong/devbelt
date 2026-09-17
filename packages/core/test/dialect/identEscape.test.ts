import { describe, expect, it } from 'vitest';
import { TableService } from '../../src/query/tableService';
import { QueryService } from '../../src/query/queryService';
import { IConnection } from '../../src/connection/connection';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';
import type { SqlDialect } from '../../src/dialect/sqlDialect';
import type { QueryCallback } from '../../src/types/query';

/**
 * 标识符包裹的注入回归。
 *
 * 威胁模型不是"用户在输入框里打了个引号"，而是**表名来自数据库自己**：
 * 扩展的树节点标签取自 `SHOW TABLES` / `pg_class` / `sqlite_master`，
 * 右键"删除表""清空表"时把 `node.label` 直接交给 TableService
 * （见 vscode-ext/src/commands/table.ts）。
 *
 * 于是在共享或不可信的数据库上，一个只有建表权限的低权限账号可以造一张
 * 名字里带反引号/双引号的表，等 DBA 在树上点一次右键菜单，payload 就以
 * **DBA 的权限**执行 —— 提权路径是"谁点的菜单"，不是"谁建的表"。
 *
 * 两道防线都要在：
 *  1. `wrap` 把包裹字符翻倍（SQL 标准的转义方式），保证即使漏了校验也逃不出标识符上下文
 *  2. `wrapQualified` 强制 `validateIdent`，把非法名字挡在生成 SQL 之前
 */

class CaptureConnection extends IConnection {
  public sqls: string[] = [];
  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }
  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    this.sqls.push(sql);
    const cb = callback || values;
    cb(null, { rows: [{ sql: '' }], affectedRows: 1 }, []);
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

const mysql = new MysqlDialect();
const pg = new PostgreSqlDialect();
const sqlite = new SqliteDialect();

function svcFor(dialect: SqlDialect): { svc: TableService; conn: CaptureConnection } {
  const conn = new CaptureConnection();
  return { svc: new TableService(new QueryService(conn, dialect)), conn };
}

describe('dialect.wrap 转义包裹字符', () => {
  it('MySQL 把内部反引号翻倍', () => {
    // 未转义时产出 `a`,`b` —— 反引号提前闭合，逗号后半段脱离标识符上下文
    expect(mysql.wrap('a`,`b')).toBe('`a``,``b`');
  });

  it('PostgreSQL 把内部双引号翻倍', () => {
    expect(pg.wrap('a","b')).toBe('"a"",""b"');
  });

  it('SQLite 把内部双引号翻倍', () => {
    expect(sqlite.wrap('a","b')).toBe('"a"",""b"');
  });

  it('无特殊字符时行为不变（不引入多余转义）', () => {
    expect(mysql.wrap('users')).toBe('`users`');
    expect(pg.wrap('users')).toBe('"users"');
    expect(sqlite.wrap('users')).toBe('"users"');
  });

  it('中文与连字符标识符不受影响（IDENT_RE 刻意放行的那批）', () => {
    expect(mysql.wrap('用户表')).toBe('`用户表`');
    expect(mysql.wrap('happy-crewman')).toBe('`happy-crewman`');
  });
});

describe('wrapQualified 强制校验标识符', () => {
  const payload = 'x`; DROP TABLE `users';

  it('dropTable 拒绝带反引号的表名', async () => {
    const { svc, conn } = svcFor(mysql);
    await expect(svc.dropTable(payload)).rejects.toThrow(/Invalid SQL identifier/);
    expect(conn.sqls).toHaveLength(0);
  });

  it('truncateTable 拒绝带反引号的表名', async () => {
    const { svc, conn } = svcFor(mysql);
    await expect(svc.truncateTable(payload)).rejects.toThrow(/Invalid SQL identifier/);
    expect(conn.sqls).toHaveLength(0);
  });

  it('dropTable 拒绝带反引号的库名', async () => {
    const { svc, conn } = svcFor(mysql);
    await expect(svc.dropTable('users', payload)).rejects.toThrow(/Invalid SQL identifier/);
    expect(conn.sqls).toHaveLength(0);
  });

  it('dupTable 两端都校验', async () => {
    const { svc } = svcFor(mysql);
    await expect(svc.dupTable(payload, 'copy')).rejects.toThrow(/Invalid SQL identifier/);
    await expect(svc.dupTable('users', payload)).rejects.toThrow(/Invalid SQL identifier/);
  });

  it('renameTable 两端都校验', async () => {
    const { svc } = svcFor(mysql);
    await expect(svc.renameTable(payload, 'ok')).rejects.toThrow(/Invalid SQL identifier/);
    await expect(svc.renameTable('users', payload)).rejects.toThrow(/Invalid SQL identifier/);
  });

  it('dropView 拒绝非法视图名', async () => {
    const { svc, conn } = svcFor(mysql);
    await expect(svc.dropView(payload)).rejects.toThrow(/Invalid SQL identifier/);
    expect(conn.sqls).toHaveLength(0);
  });

  it('合法表名仍然照常工作', async () => {
    const { svc, conn } = svcFor(mysql);
    await svc.dropTable('users', 'shop');
    expect(conn.sqls[0]).toBe('DROP TABLE `shop`.`users`');
  });

  it('合法的中文表名不被误挡', async () => {
    const { svc, conn } = svcFor(mysql);
    await svc.truncateTable('用户表');
    expect(conn.sqls[0]).toBe('TRUNCATE TABLE `用户表`');
  });
});

describe('getCreateSql 的字面量分支', () => {
  it('SQLite 分支拒绝带单引号的表名（该分支把表名拼进字符串字面量）', async () => {
    const { svc, conn } = svcFor(sqlite);
    // sqlite3 经 CLI stdin 执行，天然支持多语句：闭合字面量后即可追加任意语句
    await expect(svc.getCreateSql("x'; DROP TABLE users; --")).rejects.toThrow(
      /Invalid SQL identifier/,
    );
    expect(conn.sqls).toHaveLength(0);
  });

  it('SQLite 合法表名仍生成查询', async () => {
    const { svc, conn } = svcFor(sqlite);
    await svc.getCreateSql('users');
    expect(conn.sqls[0]).toContain('sqlite_master');
  });

  it('MySQL 分支拒绝带反引号的表名', async () => {
    const { svc, conn } = svcFor(mysql);
    await expect(svc.getCreateSql('x`; DROP TABLE `users')).rejects.toThrow(
      /Invalid SQL identifier/,
    );
    expect(conn.sqls).toHaveLength(0);
  });

  it('PG 分支拒绝带双引号的表名', async () => {
    const { svc, conn } = svcFor(pg);
    await expect(svc.getCreateSql('x"; DROP TABLE users; --')).rejects.toThrow(
      /Invalid SQL identifier/,
    );
    expect(conn.sqls).toHaveLength(0);
  });
});
