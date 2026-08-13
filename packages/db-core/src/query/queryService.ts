import { IConnection } from '../connection/connection';
import type { SqlDialect } from '../dialect/sqlDialect';
import type { QueryCallback, QueryResult } from '../types/query';
import type { FieldInfo } from '../types/meta';

/**
 * 查询错误封装：统一携带 SQL 与耗时，便于上层展示与排查。
 */
export class QueryError extends Error {
  constructor(
    message: string,
    public readonly sql?: string,
    public readonly costTime: number = 0,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

/**
 * 查询服务（复用连接 + 方言）。
 *
 * 负责：
 *  - 将 IConnection.query 回调风格统一为 Promise<QueryResult>
 *  - 通过方言生成分页 SQL / 元数据 SQL
 *
 * 上层（vscode-ext）只需持有本服务，无需直接接触原始驱动回调。
 */
export class QueryService {
  readonly dialect: SqlDialect;
  /** 在途查询的取消句柄（多槽，支持并发查询各自取消）。 */
  private readonly activeCancels = new Map<number, () => void>();
  private nextQueryId = 1;

  constructor(
    private readonly connection: IConnection,
    dialect: SqlDialect,
  ) {
    this.dialect = dialect;
  }

  /**
   * 执行 SQL 并返回结构化结果。
   * @param sql 查询语句
   * @param values 可选参数（预编译/占位符）
   */
  /** 默认查询超时（ms），0 = 不超时 */
  static queryTimeout = 30_000;
  /** Maximum number of rows retained in an arbitrary query result. */
  static maxResultRows = 10_000;

  async query(sql: string, values?: any): Promise<QueryResult> {
    const start = Date.now();
    const id = this.nextQueryId++;
    return new Promise<QueryResult>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (this.activeCancels.get(id) === cancel) this.activeCancels.delete(id);
        if (timer) clearTimeout(timer);
      };
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        finish();
        reject(new QueryError('Query cancelled', sql, Date.now() - start));
      };
      this.activeCancels.set(id, cancel);
      const timer = QueryService.queryTimeout > 0
        ? setTimeout(() => {
            if (!settled) {
              settled = true;
              finish();
              reject(new QueryError(`Query timeout (${QueryService.queryTimeout}ms)`, sql, Date.now() - start));
            }
          }, QueryService.queryTimeout)
        : null;
      const callback: QueryCallback = (err, results, fields) => {
        if (settled) return;
        settled = true;
        finish();
        const costTime = Date.now() - start;
        if (err) {
          reject(new QueryError(err.message, sql, costTime));
          return;
        }
        resolve(this.normalizeResult(sql, results, fields || [], costTime));
      };
      if (values !== undefined) {
        this.connection.query(sql, values, callback);
      } else {
        this.connection.query(sql, callback);
      }
    });
  }

  /** Stops delivery of the current result and lets the caller close its session. */
  cancel(): boolean {
    if (this.activeCancels.size === 0) return false;
    for (const cancelFn of this.activeCancels.values()) cancelFn();
    this.activeCancels.clear();
    this.connection.abortQuery();
    return true;
  }

  /** 执行分页查询 */
  async queryPage(sql: string, offset: number, limit: number): Promise<QueryResult> {
    return this.query(this.dialect.getPagedSql(sql, offset, limit));
  }

  /** 包裹标识符（复用方言规则） */
  wrap(identifier: string): string {
    return this.dialect.wrap(identifier);
  }

  /** 关闭连接 */
  end(): void {
    this.connection.end();
  }

  /** 将驱动回调结果规范化为 QueryResult */
  private normalizeResult(
    sql: string,
    results: any,
    fields: FieldInfo[],
    costTime: number,
  ): QueryResult {
    let rows: any[] = [];
    let affectedRows: number | undefined;
    let total: number | undefined;

    if (results && typeof results === 'object') {
      if (Array.isArray(results)) {
        rows = results;
      } else if (results.rows) {
        rows = results.rows;
      }
      if (results.affectedRows !== undefined) {
        // 兼容 mysql
        affectedRows = results.affectedRows;
      } else if (results.rowCount !== undefined) {
        // 兼容 pg
        affectedRows = results.rowCount;
        total = results.rowCount;
      }
    }

    const truncated = rows.length > QueryService.maxResultRows;
    if (truncated) rows = rows.slice(0, QueryService.maxResultRows);
    return { sql, costTime, rows, fields: fields || [], affectedRows, total, truncated };
  }
}
