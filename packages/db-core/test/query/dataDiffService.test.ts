import { describe, expect, it } from 'vitest';
import { DataDiffService } from '../../src/query/dataDiffService';
import { QueryService } from '../../src/query/queryService';
import type { MetadataService } from '../../src/query/metadataService';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { IConnection } from '../../src/connection/connection';
import type { QueryCallback } from '../../src/types/query';

class FakeConnection extends IConnection {
  private responses: any[] = [];
  private idx = 0;
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
});