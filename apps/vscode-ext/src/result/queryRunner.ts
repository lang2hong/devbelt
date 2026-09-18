import { DatabaseType, validateIdent } from '@devkit/db-core';
import type { QueryCancelToken } from '@devkit/db-core';
import { sqlSkeleton } from '@devkit/db-core/sql';
import type { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '@devkit/db-host/connection/connectionStore';
import { splitSqlStatements } from '../utils/sql';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { classifyWriteKind } from '../utils/sqlRisk';
import { dialectScanOptions } from '../utils/sqlDialectOptions';
import { buildCountSql, buildTableSelect, type ColumnTypeMap, type FilterCondition } from './tableQuerySql';
import { diagError } from '../utils/diagnostics';
import { l10n } from '../i18n';

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
  private execQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /**
   * 本 runner 是否开着一个自己发起、尚未结束的事务。
   * 连接会话是共享的（SQL 编辑器与多个表面板同一会话），只有确实由本面板
   * `BEGIN`/`SET AUTOCOMMIT=0` 打开的事务，关闭时才有权 ROLLBACK。
   */
  private openTransaction = false;
  /** 当前在途语句的取消句柄（只取消本 runner 这一条，不牵连共享会话上的其它查询）。 */
  private runningToken?: QueryCancelToken;

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
    this.runningToken?.cancel?.();
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
    this.runningToken?.cancel?.();
    // 仅回滚**本面板自己开的事务**：会话与 SQL 编辑器/其它面板共享，无条件 ROLLBACK
    // 会静默回滚他人未提交的事务（数据丢失）。
    if (this.table && this.openTransaction) {
      const session = this.manager.peek(this.conn.id);
      session?.query.query('ROLLBACK').catch(() => {});
      this.openTransaction = false;
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
      const token: QueryCancelToken = {};
      this.runningToken = token;
      if (database && this.conn.dbType === DatabaseType.MYSQL) {
        await session.query.query(`USE ${session.query.wrap(validateIdent(database))}`, undefined, { token });
      }
      const scanOpts = dialectScanOptions(this.conn.dbType);
      const stmts = splitSqlStatements(sql, scanOpts);
      // 有 onExecuted 时由 QueryExecutor 记一条「整段 SQL」的历史，这里逐条上报会重复；
      // 没有 onExecuted 时（结果面板内改 SQL 再运行）交给观察者逐条记录 ——
      // 那条路径过去完全不进历史。
      const stmtOpts = { ...(onExecuted ? { skipHistory: true } : {}), token };
      const results: any[] = [];
      for (const stmt of stmts) {
        // 用方言词法器剥离注释：`#` 只在 MySQL 是注释，PG/SQLite 里是运算符，
        // 旧的无条件 `.replace(/#.*$/gm)` 会把 `SELECT 1 # 2` 截断。
        const upper = sqlSkeleton(stmt, scanOpts).toUpperCase().trim();
        if (upper === 'BEGIN' || upper.startsWith('START TRANSACTION')) {
          await session.query.query(stmt, undefined, stmtOpts);
          transactionState = 'active';
          this.openTransaction = true;
          continue;
        }
        if (upper === 'COMMIT') { await session.query.query(stmt, undefined, stmtOpts); transactionState = 'committed'; this.openTransaction = false; continue; }
        if (upper === 'ROLLBACK') { await session.query.query(stmt, undefined, stmtOpts); transactionState = 'rolledback'; this.openTransaction = false; continue; }
        if (upper.startsWith('SET AUTOCOMMIT')) {
          await session.query.query(stmt, undefined, stmtOpts);
          if (upper.includes('= 0') || upper.includes('=0')) { transactionState = 'active'; this.openTransaction = true; }
          else this.openTransaction = false;
          continue;
        }
        const r = await session.query.query(stmt, undefined, stmtOpts);
        results.push({ ...r, kind: classifyWriteKind(stmt, scanOpts) });
      }
      const result = results[results.length - 1];
      // 表面板里也会执行 UPDATE/INSERT/DELETE/DDL。这类语句没有结果集，
      // 过去仍被塞进单结果分支渲染成「0 row(s)」，用户完全看不到执行结果。
      // 判定依据是「有没有字段」而不是语句前缀：不必解析 SQL，
      // 且 SHOW/DESCRIBE 之类返回结果集的语句自然落在结果集一侧。
      const isResultSet = Array.isArray(result?.fields) && result.fields.length > 0;
      let pkCols: string[] = [];
      let cols: any[] = [];
      if (this.table && isResultSet) {
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
      // 多结果集（一次运行多条 SELECT）时结果全部保留，交由多结果分支展示；
      // 只有「表模式且恰好一个结果集」才走单结果 + 分页/计数的分支。
      const resultSetCount = results.filter((r: any) => Array.isArray(r?.fields) && r.fields.length > 0).length;
      const singleResultSet = this.table && resultSetCount === 1;
      let total: number | undefined;
      // 写语句后不查 COUNT：既无意义，又会白跑一条查询。
      if (singleResultSet) {
        const countSql = this.getCountSql();
        if (countSql) {
          try {
            const countResult = await session.query.query(countSql, undefined, { token });
            const countRow = countResult?.rows?.[0];
            total = countRow ? Number(countRow.total ?? countRow.count ?? countRow.COUNT) : undefined;
          } catch { /* COUNT 失败不阻塞结果展示 */ }
        }
      }
      if (transactionState) this.post({ type: 'transaction', state: transactionState });
      if (singleResultSet) {
        this.lastFields = (result?.fields || []).map((f: any) => f.name);
        const colMap = new Map(cols.map((c: any) => [c.name, c]));
        const fieldsWithType = (result?.fields || []).map((f: any) => {
          const c = colMap.get(f.name);
          return { name: f.name, simpleType: c?.simpleType, type: c?.type };
        });
        this.post({
          type: 'result', result: { ...result, fields: fieldsWithType }, pkColumns: pkCols, total, sql, dbType: this.conn.dbType,
        });
      } else {
        // 写语句/DDL：交给多结果分支展示受影响行数，并保留上一次的列布局
        // （lastFields 不覆盖，否则重新查询后列宽/列序会被判定为过期而丢弃）。
        if (!this.table) this.lastFields = (result?.fields || []).map((f: any) => f.name);
        this.post({
          type: 'results', results, sql, transactionState, dbType: this.conn.dbType,
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
        this.openTransaction = false;
      }
    } finally {
      this.runningToken = undefined;
      this.post({ type: 'finished' });
    }
  }

  private async doExplain(sql: string): Promise<void> {
    if (this.disposed) return;
    try {
      if (!(await confirmSqlExecution(this.conn, sql))) return;
      this.post({ type: 'running' });
      const session = await this.manager.connect(this.conn);
      const token: QueryCancelToken = {};
      this.runningToken = token;
      const database = this.database || this.conn.database;
      if (database && this.conn.dbType === DatabaseType.MYSQL) {
        await session.query.query(`USE ${session.query.wrap(validateIdent(database))}`, undefined, { token });
      }
      // 方言 EXPLAIN 前缀：
      //  - SQLite 用 EXPLAIN QUERY PLAN 输出人类可读计划（裸 EXPLAIN 只吐 VM 字节码，
      //    对用户无用），且对非 SELECT 静默不执行，天然无副作用。
      //  - MySQL/PG 用不带 ANALYZE 的 EXPLAIN：只生成计划不执行，避免 PG 的
      //    EXPLAIN ANALYZE 对 INSERT/UPDATE/DELETE 产生真实写库副作用。
      const prefix = this.conn.dbType === DatabaseType.SQLITE ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
      const stmts = splitSqlStatements(sql, dialectScanOptions(this.conn.dbType));
      const results: any[] = [];
      let skippedDdl = false;
      for (const stmt of stmts) {
        // DDL 没有执行计划可解释（EXPLAIN CREATE/ALTER/DROP 在 MySQL/PG 是语法错误，
        // SQLite 则静默），遇到即跳过，不让数据库抛一句晦涩的语法错误。
        if (classifyWriteKind(stmt, dialectScanOptions(this.conn.dbType)) === 'ddl') {
          skippedDdl = true;
          continue;
        }
        const explainSql = `${prefix}${stmt}`;
        results.push(await session.query.query(explainSql, undefined, { token }));
      }
      if (results.length === 0 && skippedDdl) {
        this.post({ type: 'error', message: l10n('wv.query.explainUnsupported') });
      } else {
        this.post({ type: 'results', results, sql: `${prefix}${sql}`, transactionState: undefined, explain: true });
      }
    } catch (err) {
      diagError('explain failed', (err as Error).message);
      this.post({ type: 'error', message: (err as Error).message });
    } finally {
      this.runningToken = undefined;
      this.post({ type: 'finished' });
    }
  }
}