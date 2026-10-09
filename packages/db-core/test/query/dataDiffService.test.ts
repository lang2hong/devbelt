import { describe, expect, it } from 'vitest';
import { DataDiffService } from '../../src/query/dataDiffService';
import { QueryService } from '../../src/query/queryService';
import type { MetadataService } from '../../src/query/metadataService';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { IConnection } from '../../src/connection/connection';
import type { QueryCallback } from '../../src/types/query';

class FakeConnection extends IConnection {
  private responses: any[] = [];
  private idx = 0;
  readonly sqls: string[] = [];
  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }
  setResponses(rows: any[]): void {
    this.responses = rows;
    this.idx = 0;
  }
  query(_sql: string, callback?: QueryCallback): void;
  query(_sql: string, values: any, callback?: QueryCallback): void;
  query(_sql: string, values?: any, callback?: any): void {
    const cb = callback || values;
    this.sqls.push(_sql);
    const r = this.responses[this.idx] || { rows: [] };
    this.idx++;
    cb(null, r, []);
  }
  connect(cb: (err: any) => void): void { cb(null); }
  beginTransaction(cb: (err: any) => void): void { cb(null); }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean { return true; }
}

describe('DataDiffService', () => {
  function makeQueryService(conn: FakeConnection): QueryService {
    return new QueryService(conn, new MysqlDialect());
  }

  function mockMetadataService(cols: { name: string; isPrimary?: boolean }[]): MetadataService {
    return {
      getTables: async () => cols.map((c) => ({ name: c.name })),
      getColumns: async () => cols.map((c) => ({ name: c.name, isPrimary: c.isPrimary || false })),
    } as unknown as MetadataService;
  }

  it('发现新增行', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, name: 'Alice' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [] }]);
    const sourceQuery = makeQueryService(sourceConn);
    const targetQuery = makeQueryService(targetConn);
    const sourceMeta = mockMetadataService([{ name: 'id', isPrimary: true }, { name: 'name' }]);

    const result = await DataDiffService.diff(
      sourceQuery, sourceMeta, 'sourceDb',
      targetQuery, 'targetDb',
      ['users'],
    );
    expect(result.diffs[0].rows).toHaveLength(1);
    expect(result.diffs[0].rows[0].status).toBe('added');
  });

  it('发现删除行', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ id: 1, name: 'Alice' }] }]);
    const sourceQuery = makeQueryService(sourceConn);
    const targetQuery = makeQueryService(targetConn);
    const sourceMeta = mockMetadataService([{ name: 'id', isPrimary: true }, { name: 'name' }]);

    const result = await DataDiffService.diff(
      sourceQuery, sourceMeta, 'sourceDb',
      targetQuery, 'targetDb',
      ['users'],
    );
    expect(result.diffs[0].rows).toHaveLength(1);
    expect(result.diffs[0].rows[0].status).toBe('removed');
  });

  it('发现变更行', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, name: 'Alice' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ id: 1, name: 'Alicia' }] }]);
    const sourceQuery = makeQueryService(sourceConn);
    const targetQuery = makeQueryService(targetConn);
    const sourceMeta = mockMetadataService([{ name: 'id', isPrimary: true }, { name: 'name' }]);

    const result = await DataDiffService.diff(
      sourceQuery, sourceMeta, 'sourceDb',
      targetQuery, 'targetDb',
      ['users'],
    );
    expect(result.diffs[0].rows).toHaveLength(1);
    expect(result.diffs[0].rows[0].status).toBe('changed');
  });

  it('无变更时为空', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, name: 'Alice' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ id: 1, name: 'Alice' }] }]);
    const sourceQuery = makeQueryService(sourceConn);
    const targetQuery = makeQueryService(targetConn);
    const sourceMeta = mockMetadataService([{ name: 'id', isPrimary: true }, { name: 'name' }]);

    const result = await DataDiffService.diff(
      sourceQuery, sourceMeta, 'sourceDb',
      targetQuery, 'targetDb',
      ['users'],
    );
    expect(result.diffs[0].rows).toHaveLength(0);
  });

  it('generateSyncSql 生成 INSERT/DELETE/UPDATE', () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn);
    const diff: any = {
      sourceDb: 'a', targetDb: 'b',
      diffs: [{
        tableName: 'users',
        pkColumns: ['id'],
        columnNames: ['id', 'name'],
        rows: [
          { status: 'added', pkValues: { id: 1 }, sourceRow: { id: 1, name: 'Alice' } },
          { status: 'removed', pkValues: { id: 2 }, targetRow: { id: 2, name: 'Bob' } },
          { status: 'changed', pkValues: { id: 3 }, sourceRow: { id: 3, name: 'Charlie' }, targetRow: { id: 3, name: 'Chuck' } },
        ],
      }],
    };
    const sql = DataDiffService.generateSyncSql(diff, 'b', query);
    expect(sql).toContain('INSERT INTO');
    expect(sql).toContain('DELETE FROM');
    expect(sql).toContain('UPDATE');
  });
  /**
   * 回归：值转义必须走方言。
   * 曾用文件级私有 escapeValue（只处理单引号），MySQL 下 `C:\tmp` 的反斜杠
   * 未翻倍，写进目标库会被当转义符解释成制表符，同步后数据与源库不一致。
   */
  it('generateSyncSql 按方言转义反斜杠（MySQL 翻倍）', () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn);
    const diff: any = {
      sourceDb: 'a', targetDb: 'b',
      diffs: [{
        tableName: 't',
        pkColumns: ['id'],
        columnNames: ['id', 'path'],
        rows: [{ status: 'added', pkValues: { id: 1 }, sourceRow: { id: 1, path: 'C:\\tmp' } }],
      }],
    };
    const sql = DataDiffService.generateSyncSql(diff, 'b', query);
    expect(sql).toContain("'C:\\\\tmp'");
  });

  it('generateSyncSql 转义单引号与 NULL', () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn);
    const diff: any = {
      sourceDb: 'a', targetDb: 'b',
      diffs: [{
        tableName: 't',
        pkColumns: ['id'],
        columnNames: ['id', 'name', 'note'],
        rows: [{ status: 'added', pkValues: { id: 1 }, sourceRow: { id: 1, name: "O'Brien", note: null } }],
      }],
    };
    const sql = DataDiffService.generateSyncSql(diff, 'b', query);
    expect(sql).toContain("'O''Brien'");
    expect(sql).toContain('NULL');
  });

  it('无主键 NULL 键生成 IS NULL（不再 `col = NULL` 空操作）', () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn);
    const diff: any = {
      sourceDb: 'a', targetDb: 'b',
      diffs: [{
        tableName: 't',
        pkColumns: ['a', 'b'],
        columnNames: ['a', 'b'],
        rows: [{ status: 'removed', pkValues: { a: 1, b: null } }],
      }],
    };
    const sql = DataDiffService.generateSyncSql(diff, 'b', query);
    expect(sql).toContain('`b` IS NULL');
    expect(sql).not.toContain('`b` = NULL');
  });

  it('generateSyncSql 用目标方言引号/转义（MySQL 源 → PG 目标）', () => {
    const pgConn = new FakeConnection();
    const pgQuery = new QueryService(pgConn, new PostgreSqlDialect());
    const diff: any = {
      sourceDb: 'a', targetDb: 'b',
      diffs: [{
        tableName: 'users',
        pkColumns: ['id'],
        columnNames: ['id', 'path'],
        rows: [{ status: 'added', pkValues: { id: 1 }, sourceRow: { id: 1, path: 'C:\\tmp' } }],
      }],
    };
    const sql = DataDiffService.generateSyncSql(diff, 'b', pgQuery);
    // PG 一个连接一个库：database 是库名而非 schema，不得生成 "b"."users"。
    expect(sql).toContain('INSERT INTO "users"');
    expect(sql).not.toContain('"b".');
    expect(sql).toContain('"id", "path"');
    // PG 不翻倍反斜杠（standard_conforming_strings），也不发反引号
    expect(sql).toContain("'C:\\tmp'");
    expect(sql).not.toContain('`');
  });
});
describe('DataDiffService 分页策略（PG keyset 丢行回归）', () => {
  function makeQueryService(conn: FakeConnection): QueryService {
    return new QueryService(conn, new MysqlDialect());
  }
  function meta(cols: { name: string; isPrimary?: boolean }[]): MetadataService {
    return {
      getTables: async () => cols.map((c) => ({ name: c.name })),
      getColumns: async () => cols.map((c) => ({ name: c.name, isPrimary: c.isPrimary || false })),
    } as unknown as MetadataService;
  }

  it('无主键：回退 OFFSET 分页，绝不把可空全列当 keyset 游标', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ a: 1, b: null }] }, { rows: [] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [] }, { rows: [] }]);
    const result = await DataDiffService.diff(
      makeQueryService(sourceConn), meta([{ name: 'a' }, { name: 'b' }]), 's',
      makeQueryService(targetConn), 't', ['users'],
    );
    const sql = sourceConn.sqls.join('\n');
    expect(sql).toContain('LIMIT 0,'); // MySQL OFFSET 分页
    expect(sql).not.toMatch(/WHERE \(/); // 未使用 keyset
    expect(result.diffs[0].rows[0].status).toBe('added');
  });

  it('有主键：走 keyset（ORDER BY 主键），不用 OFFSET', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, name: 'Alice' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [] }]);
    await DataDiffService.diff(
      makeQueryService(sourceConn), meta([{ name: 'id', isPrimary: true }, { name: 'name' }]), 's',
      makeQueryService(targetConn), 't', ['users'],
    );
    const sql = sourceConn.sqls.join('\n');
    expect(sql).toContain('ORDER BY `id` LIMIT');
    expect(sql).not.toContain('LIMIT 0,');
  });

  it('数值主键同方言：有序归并（流式）结果与按键比对一致', async () => {
    const numericMeta = (cols: { name: string; type: string; isPrimary?: boolean }[]): MetadataService => ({
      getTables: async () => cols.map((c) => ({ name: c.name })),
      getColumns: async () => cols,
    } as unknown as MetadataService);
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 4, v: 'd' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ id: 1, v: 'a' }, { id: 3, v: 'c' }] }]);
    const cols = [{ name: 'id', type: 'int(11)', isPrimary: true }, { name: 'v', type: 'varchar(10)' }];
    const result = await DataDiffService.diff(
      makeQueryService(sourceConn), numericMeta(cols), 's',
      makeQueryService(targetConn), 't', ['users'],
    );
    const rows = result.diffs[0].rows;
    expect(rows.filter((r) => r.status === 'added').map((r) => r.pkValues.id)).toEqual([2, 4]);
    expect(rows.filter((r) => r.status === 'removed').map((r) => r.pkValues.id)).toEqual([3]);
    expect(sourceConn.sqls.join('\n')).toContain('ORDER BY `id`');
  });

  it('跨方言值比较：数值与数值型字符串视为相等（不误报 changed）', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, v: '1' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ id: 1, v: 1 }] }]);
    const result = await DataDiffService.diff(
      makeQueryService(sourceConn), meta([{ name: 'id', isPrimary: true }, { name: 'v' }]), 's',
      makeQueryService(targetConn), 't', ['users'],
    );
    // '1' 与 1 语义相同 → 无差异（旧实现 String 比较也会相等，但 null/日期等需归一）。
    expect(result.diffs[0].rows).toEqual([]);
  });

  it('超大 BIGINT 主键归并：不因 Number() 折叠而漏判（993 vs 992）', async () => {
    const numericMeta = (cols: { name: string; type: string; isPrimary?: boolean }[]): MetadataService => ({
      getTables: async () => cols.map((c) => ({ name: c.name })),
      getColumns: async () => cols,
    } as unknown as MetadataService);
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: '9007199254740993', v: 'same' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ id: '9007199254740992', v: 'same' }] }]);
    const cols = [{ name: 'id', type: 'bigint', isPrimary: true }, { name: 'v', type: 'varchar(10)' }];
    const result = await DataDiffService.diff(
      makeQueryService(sourceConn), numericMeta(cols), 's',
      makeQueryService(targetConn), 't', ['users'],
    );
    const rows = result.diffs[0].rows;
    // 两个不同主键：一个 added、一个 removed；旧实现会把它们当同一行（Number 折叠）。
    expect(rows.filter((r) => r.status === 'added').map((r) => String(r.pkValues.id))).toEqual(['9007199254740993']);
    expect(rows.filter((r) => r.status === 'removed').map((r) => String(r.pkValues.id))).toEqual(['9007199254740992']);
    expect(sourceConn.sqls.join('\n')).toContain('ORDER BY `id`');
  });

  it('DECIMAL 值比较：超过 2^53 的精度差异必须判为 changed', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ k: 'r1', n: '9007199254740993' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ k: 'r1', n: '9007199254740992' }] }]);
    const result = await DataDiffService.diff(
      makeQueryService(sourceConn), meta([{ name: 'k', isPrimary: true }, { name: 'n' }]), 's',
      makeQueryService(targetConn), 't', ['users'],
    );
    expect(result.diffs[0].rows.map((r) => r.status)).toEqual(['changed']);
  });

  it('日期比较：小数秒与带时区偏移的同一时刻应归一相等', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ k: 'r1', t: '2024-01-01T08:00:00+08:00' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ k: 'r1', t: '2024-01-01T00:00:00Z' }] }]);
    const result = await DataDiffService.diff(
      makeQueryService(sourceConn), meta([{ name: 'k', isPrimary: true }, { name: 't' }]), 's',
      makeQueryService(targetConn), 't', ['users'],
    );
    expect(result.diffs[0].rows).toEqual([]);
  });

  it('日期比较：毫秒差异必须判为 changed（不截断小数秒）', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ k: 'r1', t: '2024-01-01T00:00:00.500Z' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ k: 'r1', t: '2024-01-01T00:00:00.400Z' }] }]);
    const result = await DataDiffService.diff(
      makeQueryService(sourceConn), meta([{ name: 'k', isPrimary: true }, { name: 't' }]), 's',
      makeQueryService(targetConn), 't', ['users'],
    );
    expect(result.diffs[0].rows.map((r) => r.status)).toEqual(['changed']);
  });

  it('跨方言值比较：null 与 undefined 等价，Date 与等价时间戳相等', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, v: null, t: new Date('2024-01-01T00:00:00Z') }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [{ id: 1, t: '2024-01-01 00:00:00' }] }]);
    const result = await DataDiffService.diff(
      makeQueryService(sourceConn), meta([{ name: 'id', isPrimary: true }, { name: 'v' }, { name: 't' }]), 's',
      makeQueryService(targetConn), 't', ['users'],
    );
    // v: null vs 缺失等价；t: Date(2024-01-01T00:00:00Z) 与 '2024-01-01 00:00:00' 归一后相等。
    expect(result.diffs[0].rows).toEqual([]);
  });

  it('PG：sourceSchema/targetSchema 限定 SELECT 与同步 SQL（同连接跨 schema）', async () => {
    const sourceConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, name: 'A' }] }]);
    const targetConn = new FakeConnection();
    targetConn.setResponses([{ rows: [] }]);
    const pg = new PostgreSqlDialect();
    const result = await DataDiffService.diff(
      new QueryService(sourceConn, pg), meta([{ name: 'id', isPrimary: true }, { name: 'name' }]), 'mydb',
      new QueryService(targetConn, pg), 'mydb', ['users'],
      { sourceSchema: 'sales', targetSchema: 'staging' },
    );
    // 源/目标 SELECT 各自限定到对应 schema。
    expect(sourceConn.sqls.some((s) => s.includes('FROM "sales"."users"'))).toBe(true);
    expect(targetConn.sqls.some((s) => s.includes('FROM "staging"."users"'))).toBe(true);

    const sql = DataDiffService.generateSyncSql(result, 'mydb', new QueryService(targetConn, pg), 'staging');
    expect(sql).toContain('INSERT INTO "staging"."users"');
    expect(sql).not.toContain('"sales"."users"');
  });
});
