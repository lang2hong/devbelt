import { describe, expect, it } from 'vitest';
import { DataTransferService } from '../../src/query/dataTransferService';
import { QueryService } from '../../src/query/queryService';
import type { MetadataService } from '../../src/query/metadataService';
import type { TableService } from '../../src/query/tableService';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
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
    // SchemaDiffService.generateSyncSql 会先查能力，缺这个方法会抛 TypeError
    // 被 schema catch 吞掉并 continue，从而跳过数据阶段（掩盖被测行为）
    supports: () => true,
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

/**
 * splitSql 的注释处理回归。
 *
 * 该函数是 transferDatabase / syncTableData 唯一的语句切分入口。它曾把 `--`
 * 注释正文写回缓冲区，导致 generateSyncSql 的产物（首行就是注释）被切成
 * 「注释+语句」一整块，再被调用方的 startsWith('--') 过滤整条丢弃 ——
 * 数据同步实际从未执行。这里通过公开行为间接锁定：注释不得影响语句执行。
 */
describe('splitSql 注释处理（经 transferDatabase 间接验证）', () => {
  it('产物首行是注释时，语句仍被执行', async () => {
    const sourceConn = new FakeConnection();
    const targetConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, name: 'Alice' }] }, { rows: [] }]);

    const sourceQuery = new QueryService(sourceConn, new MysqlDialect());
    const targetQuery = new QueryService(targetConn, new MysqlDialect());

    await DataTransferService.transferDatabase(
      sourceQuery, meta(['t'], ['id', 'name']), tableSvc(), 'src',
      targetQuery, meta([], ['id', 'name']), 'dst',
      { tables: ['t'], includeData: true },
    );

    // 执行到目标库的语句不应有任何一条以注释开头
    const dataStmts = targetConn.executed.filter((s) => /INSERT INTO/i.test(s));
    expect(dataStmts.length).toBeGreaterThan(0);
    for (const stmt of dataStmts) {
      expect(stmt.trimStart().startsWith('--')).toBe(false);
    }
  });

  it('注释内的分号不会把语句切断', async () => {
    const sourceConn = new FakeConnection();
    const targetConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, name: 'a;b' }] }, { rows: [] }]);

    const sourceQuery = new QueryService(sourceConn, new MysqlDialect());
    const targetQuery = new QueryService(targetConn, new MysqlDialect());

    await DataTransferService.transferDatabase(
      sourceQuery, meta(['t'], ['id', 'name']), tableSvc(), 'src',
      targetQuery, meta([], ['id', 'name']), 'dst',
      { tables: ['t'], includeData: true },
    );

    // 字符串字面量里的分号不参与切分，整条 INSERT 保持完整
    const insert = targetConn.executed.find((s) => /INSERT INTO/i.test(s)) ?? '';
    expect(insert).toContain("'a;b'");
    expect(insert).toMatch(/VALUES\s*\(/);
  });
});

describe('DataTransferService.transferTable', () => {
  /**
   * 回归：单表迁移的值转义必须用**目标**方言。
   * 曾自建只处理单引号的转义，跨库迁移时 MySQL 目标库会把 `C:\tmp`
   * 的反斜杠当转义符，写进去的数据与源库不一致。
   */
  it('值按目标方言转义（MySQL 目标：反斜杠翻倍）', async () => {
    const sourceConn = new FakeConnection();
    const targetConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, path: 'C:\\tmp' }] }, { rows: [] }]);

    // 源 PG、目标 MySQL：转义规则必须跟目标走
    const sourceQuery = new QueryService(sourceConn, new PostgreSqlDialect());
    const targetQuery = new QueryService(targetConn, new MysqlDialect());

    await DataTransferService.transferTable(
      sourceQuery, meta(['t'], ['id', 'path']), tableSvc(), 'src', 't',
      targetQuery, meta([], ['id', 'path']), 'dst',
      { includeData: true },
    );

    const insert = targetConn.executed.find((s) => /INSERT INTO/i.test(s)) ?? '';
    expect(insert).toContain("'C:\\\\tmp'");
  });

  it('值按目标方言转义（PG 目标：反斜杠不翻倍）', async () => {
    const sourceConn = new FakeConnection();
    const targetConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, path: 'C:\\tmp' }] }, { rows: [] }]);

    const sourceQuery = new QueryService(sourceConn, new MysqlDialect());
    const targetQuery = new QueryService(targetConn, new PostgreSqlDialect());

    await DataTransferService.transferTable(
      sourceQuery, meta(['t'], ['id', 'path']), tableSvc(), 'src', 't',
      targetQuery, meta([], ['id', 'path']), 'dst',
      { includeData: true },
    );

    const insert = targetConn.executed.find((s) => /INSERT INTO/i.test(s)) ?? '';
    expect(insert).toContain("'C:\\tmp'");
    expect(insert).not.toContain("'C:\\\\tmp'");
  });

  it('NULL 与单引号正确转义', async () => {
    const sourceConn = new FakeConnection();
    const targetConn = new FakeConnection();
    sourceConn.setResponses([{ rows: [{ id: 1, name: "O'Brien", note: null }] }, { rows: [] }]);

    const sourceQuery = new QueryService(sourceConn, new MysqlDialect());
    const targetQuery = new QueryService(targetConn, new MysqlDialect());

    await DataTransferService.transferTable(
      sourceQuery, meta(['t'], ['id', 'name', 'note']), tableSvc(), 'src', 't',
      targetQuery, meta([], ['id', 'name', 'note']), 'dst',
      { includeData: true },
    );

    const insert = targetConn.executed.find((s) => /INSERT INTO/i.test(s)) ?? '';
    expect(insert).toContain("'O''Brien'");
    expect(insert).toContain('NULL');
  });
});
