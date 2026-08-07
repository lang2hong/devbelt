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
  async query(sql: string, values?: any): Promise<QueryResult> {
    const start = Date.now();
    return new Promise<QueryResult>((resolve, reject) => {
      const callback: QueryCallback = (err, results, fields) => {
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

    return { sql, costTime, rows, fields: fields || [], affectedRows, total };
  }
}