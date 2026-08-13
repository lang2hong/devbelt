import { DatabaseType, validateIdent } from '@db-client/core';
import type { QueryService } from '@db-client/core';
import type { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import { splitSqlStatements } from '../utils/sql';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { buildCountSql, buildTableSelect, type FilterCondition } from './tableQuerySql';
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
      this.conn.dbType, this.table, undefined, this.filterConditions,
      this.sortCol, this.sortDir, this.offset, this.limit,
    );
  }

  getCountSql(): string {
    if (!this.table) return '';
    return buildCountSql(this.conn.dbType, this.table, undefined, this.filterConditions);
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
    if (!this.runningQuery?.cancel()) return;
    // Closing the driver session interrupts MySQL and PostgreSQL requests; the
    // next command transparently creates a fresh session.
    this.manager.disposeConn(this.conn.id);
  }

  reset(): void {
    this.sortCol = '';
    this.sortDir = '';
    this.filterConditions = [];
    this.offset = 0;
  }

  /** 视图销毁时调用，阻止后续在途执行。 */
  dispose(): void {
    this.disposed = true;
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
    try {
      if (!(await confirmSqlExecution(this.conn, sql))) return;
      this.post({ type: 'running' });
      const session = await this.manager.connect(this.conn);
      this.runningQuery = session.query;
      if (database && this.conn.dbType === DatabaseType.MYSQL) {
        await session.query.query(`USE ${session.query.wrap(validateIdent(database))}`);
      }
      const stmts = splitSqlStatements(sql);
      const results: any[] = [];
      for (const stmt of stmts) {
        const upper = stmt.toUpperCase().trim();
        if (upper === 'BEGIN' || upper.startsWith('START TRANSACTION')) {
          await session.query.query(stmt);
          transactionState = 'active';
          continue;
        }
        if (upper === 'COMMIT') { await session.query.query(stmt); transactionState = 'committed'; continue; }
        if (upper === 'ROLLBACK') { await session.query.query(stmt); transactionState = 'rolledback'; continue; }
        results.push(await session.query.query(stmt));
      }
      const result = results[results.length - 1];
      let pkCols: string[] = [];
      let cols: any[] = [];
      if (this.table) {
        try {
          cols = await session.metadata.getColumns(this.table, this.database);
          pkCols = cols.filter((c: any) => c.isPrimary).map((c: any) => c.name);
          // 无主键时用所有列作为定位列（编辑/删除可用，可能影响多行）
          if (pkCols.length === 0) pkCols = cols.map((c: any) => c.name);
        } catch {}
      }
      // 表预览时并行查询过滤后总条数，用于分页信息
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
        // 表预览模式：给 fields 补列类型，供 filter 智能控件
        const colMap = new Map(cols.map((c: any) => [c.name, c]));
        const fieldsWithType = (result?.fields || []).map((f: any) => {
          const c = colMap.get(f.name);
          return { name: f.name, simpleType: c?.simpleType, type: c?.type };
        });
        this.post({
          type: 'result', result: { ...result, fields: fieldsWithType }, pkColumns: pkCols, total, sql,
        });
      } else {
        // 查询模式发送所有结果集
        this.post({
          type: 'results', results, sql, transactionState,
        });
      }
      onExecuted?.(result);
    } catch (err) {
      diagError('query failed', (err as Error).message);
      this.post({ type: 'error', message: (err as Error).message });
      onExecuted?.(undefined, err as Error);
      // 事务未提交：回滚防止状态泄漏到后续查询
      if (transactionState === 'active') {
        try {
          const s = await this.manager.connect(this.conn);
          await s.query.query('ROLLBACK');
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