import { DatabaseType, validateIdent } from '@db-client/core';
import type { QueryService } from '@db-client/core';
import type { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import { splitSqlStatements } from '../utils/sql';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { buildCountSql, buildTableSelect, type ColumnTypeMap, type FilterCondition } from './tableQuerySql';
import { diagError } from '../utils/diagnostics';

/**
 * 查询执行器：持有表/查询的查询状态（分页、排序、筛选、运行句柄），
 * 并封装 execute / explain / cancel / buildSelect。
 *
 * 与视图解耦：经注入的 post 回调输出运行状态与结果。
 * 同一视图/会话的查询通过串行队列按序执行，避免并发污染 USE/事务状态并防止取消句柄被覆盖。
 */
export class QueryRunner {
  offset = 0;
  sortCol = '';
  sortDir = '';
  filterConditions: FilterCondition[] = [];
  lastFields: string[] = [];
  limit = 100;
  private runningQuery?: QueryService;
  private execQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  /**
   * 列名 → 列类型，由每次执行时已取到的元数据填充。
   *
   * 筛选条件要按列类型决定值是否加引号：varchar 列填 `1` 必须写成 `'1'`，
   * 否则 MySQL 会把整列转 double 比较（`'01'`/`' 1'`/`'1abc'` 全部误命中且索引失效）。
   * 首次执行前为空，此时一律加引号——对数值列语义等价，是安全的默认。
   */
  private columnTypes: ColumnTypeMap = {};

  constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    private readonly table: string | undefined,
    private readonly database: string | undefined,
    private readonly post: (msg: any) => void,
  ) {}

  get hasTable(): boolean {
    return !!this.table;
  }

  buildSelect(): string {
    if (!this.table) return '';
    return buildTableSelect(
      this.conn.dbType, this.table, this.database, this.filterConditions,
      this.sortCol, this.sortDir, this.offset, this.limit, this.columnTypes,
    );
  }

  getCountSql(): string {
    if (!this.table) return '';
    return buildCountSql(this.conn.dbType, this.table, this.database, this.filterConditions, this.columnTypes);
  }

  execute(
    sql: string,
    onExecuted?: (result: any, error?: Error) => void,
    database = this.database || this.conn.database,
  ): Promise<void> {
    return this.enqueue(() => this.doExecute(sql, onExecuted, database));
  }

  explain(sql: string): Promise<void> {
    return this.enqueue(() => this.doExplain(sql));
  }

  cancel(): void {
    this.runningQuery?.cancel();
  }

  reset(): void {
    this.sortCol = '';
    this.sortDir = '';
    this.filterConditions = [];
    this.offset = 0;
  }

  /**
   * 视图销毁时调用，取消在途查询并阻止后续执行。
   *
   * ROLLBACK 只对**已存在**的会话发送：此处不能用 `connect()`，否则视图关闭时
   * 会话已被释放，connect 又会新建一条无人持有的连接（连同 SSH 隧道）而泄漏。
   */
  dispose(): void {
    this.disposed = true;
    this.runningQuery?.cancel();
    if (this.table) {
      const session = this.manager.peek(this.conn.id);
      session?.query.query('ROLLBACK').catch(() => {});
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.execQueue.then(fn, fn);
    this.execQueue = run.catch(() => {});
    return run;
  }

  private async doExecute(
    sql: string,
    onExecuted?: (result: any, error?: Error) => void,
    database = this.database || this.conn.database,
  ): Promise<void> {
    if (this.disposed) return;
    let transactionState: 'active' | 'committed' | 'rolledback' | undefined;
    let session: any = undefined;
    try {
      if (!(await confirmSqlExecution(this.conn, sql))) return;
      this.post({ type: 'running' });
      session = await this.manager.connect(this.conn);
      this.runningQuery = session.query;
      if (database && this.conn.dbType === DatabaseType.MYSQL) {
        await session.query.query(`USE ${session.query.wrap(validateIdent(database))}`);
      }
      const stmts = splitSqlStatements(sql);
      const results: any[] = [];
      for (const stmt of stmts) {
        const upper = stmt.trim().replace(/--.*$/gm, '').replace(/#.*$/gm, '').toUpperCase().trim();
        if (upper === 'BEGIN' || upper.startsWith('START TRANSACTION')) {
          await session.query.query(stmt);
          transactionState = 'active';
          continue;
        }
        if (upper === 'COMMIT') { await session.query.query(stmt); transactionState = 'committed'; continue; }
        if (upper === 'ROLLBACK') { await session.query.query(stmt); transactionState = 'rolledback'; continue; }
        if (upper.startsWith('SET AUTOCOMMIT')) {
          await session.query.query(stmt);
          if (upper.includes('= 0') || upper.includes('=0')) transactionState = 'active';
          continue;
        }
        results.push(await session.query.query(stmt));
      }
      const result = results[results.length - 1];
      let pkCols: string[] = [];
      let cols: any[] = [];
      if (this.table) {
        try {
          cols = await session.metadata.getColumns(this.table, this.database);
          pkCols = cols.filter((c: any) => c.isPrimary).map((c: any) => c.name);
          if (pkCols.length === 0) pkCols = cols.map((c: any) => c.name);
          // 供后续筛选/计数决定值是否加引号；首屏查询无 WHERE，因此这里填充得
          // 及时（用户加筛选前必然已经跑过一次首屏）。取不到时保持为空，
          // 退化为「一律加引号」的安全默认。
          this.columnTypes = Object.fromEntries(
            cols.map((c: any) => [c.name, c.simpleType || c.type]),
          );
        } catch {}
      }
      let total: number | undefined;
      if (this.table) {
        const countSql = this.getCountSql();
        if (countSql) {
          try {
            const countResult = await session.query.query(countSql);
            const countRow = countResult?.rows?.[0];
            total = countRow ? Number(countRow.total ?? countRow.count ?? countRow.COUNT) : undefined;
          } catch { /* COUNT 失败不阻塞结果展示 */ }
        }
      }
      this.lastFields = (result?.fields || []).map((f: any) => f.name);
      if (transactionState) this.post({ type: 'transaction', state: transactionState });
      if (this.table) {
        const colMap = new Map(cols.map((c: any) => [c.name, c]));
        const fieldsWithType = (result?.fields || []).map((f: any) => {
          const c = colMap.get(f.name);
          return { name: f.name, simpleType: c?.simpleType, type: c?.type };
        });
        this.post({
          type: 'result', result: { ...result, fields: fieldsWithType }, pkColumns: pkCols, total, sql,
        });
      } else {
        this.post({
          type: 'results', results, sql, transactionState,
        });
      }
      onExecuted?.(result);
    } catch (err) {
      diagError('query failed', (err as Error).message);
      this.post({ type: 'error', message: (err as Error).message });
      onExecuted?.(undefined, err as Error);
      if (transactionState === 'active' && session) {
        try {
          await session.query.query('ROLLBACK');
        } catch { /* best-effort rollback */ }
      }
    } finally {
      this.runningQuery = undefined;
      this.post({ type: 'finished' });
    }
  }

  private async doExplain(sql: string): Promise<void> {
    if (this.disposed) return;
    try {
      if (!(await confirmSqlExecution(this.conn, sql))) return;
      this.post({ type: 'running' });
      const session = await this.manager.connect(this.conn);
      this.runningQuery = session.query;
      const database = this.database || this.conn.database;
      if (database && this.conn.dbType === DatabaseType.MYSQL) {
        await session.query.query(`USE ${session.query.wrap(validateIdent(database))}`);
      }
      const prefix = this.conn.dbType === DatabaseType.PG ? 'EXPLAIN ANALYZE ' : 'EXPLAIN ';
      const stmts = splitSqlStatements(sql);
      const results: any[] = [];
      for (const stmt of stmts) {
        const explainSql = `${prefix}${stmt}`;
        results.push(await session.query.query(explainSql));
      }
      this.post({ type: 'results', results, sql: `${prefix}${sql}`, transactionState: undefined, explain: true });
    } catch (err) {
      diagError('explain failed', (err as Error).message);
      this.post({ type: 'error', message: (err as Error).message });
    } finally {
      this.runningQuery = undefined;
      this.post({ type: 'finished' });
    }
  }
}