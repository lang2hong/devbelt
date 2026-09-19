import { describe, expect, it } from 'vitest';
import { DataTransferService } from '../../src/query/dataTransferService';
import { DatabaseType } from '../../src/types/connection';
import { QueryService } from '../../src/query/queryService';
import type { MetadataService } from '../../src/query/metadataService';
import type { TableService } from '../../src/query/tableService';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { IConnection } from '../../src/connection/connection';
import type { QueryCallback } from '../../src/types/query';

class FakeConnection extends IConnection {
  private responses: any[] = [];
  private idx = 0;
  /** 收到的全部 SQL，供断言执行序列 */
  readonly executed: string[] = [];
  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }
  setResponses(rows: any[]): void {
    this.responses = rows;
    this.idx = 0;
  }
  query(_sql: string, callback?: QueryCallback): void;
  query(_sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    const cb = callback || values;
    this.executed.push(sql);
    const r = this.responses[this.idx] ?? { rows: [] };
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

function meta(tables: string[], cols: string[]): MetadataService {
  return {
    getTables: async () => tables.map((name) => ({ name })),
    getColumns: async () => cols.map((name) => ({ name })),
  } as unknown as MetadataService;
}

function tableSvc(): TableService {
  return {
    getCreateSql: async () => 'CREATE TABLE `t` (`id` int)',
    // SchemaDiffService.generateSyncSql 会先查能力与方言，缺这些会抛 TypeError
    // 被 schema catch 吞掉并 continue，从而跳过数据阶段（掩盖被测行为）。
    supports: () => true,
    dbType: DatabaseType.MYSQL,
  } as unknown as TableService;
}

describe('DataTransferService.transferDatabase', () => {
  /**
   * 回归：源库新增的表（schema diff status='added'）必须同步**结构和数据**。
   *
   * 原实现里数据阶段带 `diff?.status !== 'added'` 排除条件，配套一个
   * `else if (diff?.status === 'added')` 想走 transferTable 补数据；但那个 else-if
   * 永不可达（前一个 `if (diff && diff.status !== 'unchanged')` 已吞掉 'added'），
   * 于是新增表只建了结构、数据从未复制。
   */
  it('added 表的数据阶段会执行（不再被静默跳过）', async () => {
    const sourceConn = new FakeConnection();
    const targetConn = new FakeConnection();
    // 源库两次分页读：先返回一行，再返回空表示结束
    sourceConn.setResponses([{ rows: [{ id: 1, name: 'Alice' }] }, { rows: [] }]);

    const sourceQuery = new QueryService(sourceConn, new MysqlDialect());
    const targetQuery = new QueryService(targetConn, new MysqlDialect());

    await DataTransferService.transferDatabase(
      sourceQuery, meta(['t'], ['id', 'name']), tableSvc(), 'src',
      targetQuery, meta([], ['id', 'name']), 'dst',
      { tables: ['t'], includeData: true },
    );

    // 目标库应收到 INSERT（数据阶段真的跑了）
    const insertStmts = targetConn.executed.filter((s) => /INSERT INTO/i.test(s));
    expect(insertStmts.length).toBeGreaterThan(0);
  });

  it('includeData=false 时只同步结构，不发 INSERT', async () => {
    const sourceConn = new FakeConnection();
    const targetConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1 }] }, { rows: [] }]);

    const sourceQuery = new QueryService(sourceConn, new MysqlDialect());
    const targetQuery = new QueryService(targetConn, new MysqlDialect());

    await DataTransferService.transferDatabase(
      sourceQuery, meta(['t'], ['id']), tableSvc(), 'src',
      targetQuery, meta([], ['id']), 'dst',
      { tables: ['t'], includeData: false },
    );

    expect(targetConn.executed.filter((s) => /INSERT INTO/i.test(s))).toHaveLength(0);
  });

  it('isCancelled 立即抛出，不执行任何语句', async () => {
    const sourceConn = new FakeConnection();
    const targetConn = new FakeConnection();
    const sourceQuery = new QueryService(sourceConn, new MysqlDialect());
    const targetQuery = new QueryService(targetConn, new MysqlDialect());

    await expect(DataTransferService.transferDatabase(
      sourceQuery, meta(['t'], ['id']), tableSvc(), 'src',
      targetQuery, meta([], ['id']), 'dst',
      { tables: ['t'], isCancelled: () => true },
    )).rejects.toThrow('Transfer cancelled');
  });
});
