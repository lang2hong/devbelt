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

/** 单次查询的行为选项。 */
export interface QueryOptions {
  /**
   * 跳过 `maxResultRows` 截断。
   * 仅用于元数据读取——截断元数据会造成功能缺项（表/列清单少项）而非单纯展示问题。
   */
  noTruncate?: boolean;
  /**
   * 不通知 `QueryObserver`。
   *
   * 两种必须跳过的场合：
   *  - **含密码的语句**（CREATE USER / ALTER USER ... IDENTIFIED BY）。历史会被
   *    持久化并参与云同步，明文密码绝不能进去。
   *  - **批量循环**（导入每行 INSERT、恢复 dump、库间传输）。逐条上报会把
   *    上限 100 条的历史瞬间冲干，还会带来每条一次的持久化写入。
   *    这类操作由命令层补一条汇总记录。
   */
  skipHistory?: boolean;
}

/** 一条已执行语句的观测信息。 */
export interface ExecutedStatement {
  /** 实际下发给驱动的 SQL 原文。 */
  sql: string;
  /** 驱动实测耗时（ms）。 */
  costTime: number;
  /** 写语句的影响行数（读语句为 undefined）。 */
  affectedRows?: number;
  /** 读语句返回的行数（写语句为 0）。 */
  rowCount: number;
  /** 失败时的错误信息；成功为 undefined。 */
  error?: string;
}

/**
 * 语句执行观察者。
 *
 * db-core 不依赖 vscode，无法自己写查询历史；由 vscode-ext 在构造
 * `QueryService` 时注入，从而让**所有**经过本服务的语句（不止编辑器执行的那些）
 * 都能被记录，而不必在几十个 DDL 调用点逐个补写。
 */
export type QueryObserver = (info: ExecutedStatement) => void;

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
    /** 可选语句观察者（vscode-ext 用它写查询历史）。 */
    private readonly observer?: QueryObserver,
  ) {
    this.dialect = dialect;
  }

  /**
   * 通知观察者，并吞掉它抛出的任何异常。
   *
   * 观察者是旁路设施（写历史），它出错绝不能影响一条已经成功执行的语句 ——
   * 否则用户会看到「DDL 报错」而库里其实已经改完了。
   */
  private notifyObserver(info: ExecutedStatement, options?: QueryOptions): void {
    if (!this.observer || options?.skipHistory) return;
    try {
      this.observer(info);
    } catch { /* best-effort observation */ }
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

  async query(sql: string, values?: any, options?: QueryOptions): Promise<QueryResult> {
    if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
      throw new QueryError('SQL statement cannot be empty');
    }
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
        this.connection.abortQuery();
        reject(new QueryError('Query cancelled', sql, Date.now() - start));
      };
      this.activeCancels.set(id, cancel);
      const timer = QueryService.queryTimeout > 0
        ? setTimeout(() => {
            if (!settled) {
              settled = true;
              finish();
              this.connection.abortQuery();
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
          this.notifyObserver({ sql, costTime, rowCount: 0, error: err.message }, options);
          reject(new QueryError(err.message, sql, costTime));
          return;
        }
        const result = this.normalizeResult(sql, results, fields || [], costTime, options);
        this.notifyObserver(
          { sql, costTime, rowCount: result.rows.length, affectedRows: result.affectedRows },
          options,
        );
        resolve(result);
      };
      if (values !== undefined) {
        this.connection.query(sql, values, callback);
      } else {
        this.connection.query(sql, callback);
      }
    });
  }

  /** 当前在途查询数（供连接池统计区分「活跃」与「空闲」会话）。 */
  get inFlightCount(): number {
    return this.activeCancels.size;
  }

  /** Stops delivery of the current result and lets the caller close its session. */
  cancel(): boolean {
    if (this.activeCancels.size === 0) return false;
    const cancels = [...this.activeCancels.values()];
    this.activeCancels.clear();
    for (const cancelFn of cancels) cancelFn();
    this.connection.abortQuery();
    return true;
  }

  /**
   * 执行不截断的查询，供元数据读取使用。
   *
   * `maxResultRows` 是面向「用户任意查询」的内存保护；元数据（表/列/索引清单）
   * 被截断会导致功能性缺项而非展示问题，因此单独开一条不截断的路径。
   */
  async queryAll(sql: string, values?: any): Promise<QueryResult> {
    // 元数据读取不进历史：它们由树展开/补全自动触发，量大且对用户无意义。
    return this.query(sql, values, { noTruncate: true, skipHistory: true });
  }

  /** 执行分页查询 */
  async queryPage(sql: string, offset: number, limit: number): Promise<QueryResult> {
    // 分页读取（导出、备份、数据对比）同样不进历史。
    return this.query(this.dialect.getPagedSql(sql, offset, limit), undefined, { skipHistory: true });
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
    options?: QueryOptions,
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

    // 元数据查询必须拿全量：库里表数超过 maxResultRows 时，截断会让
    // 树视图、补全、导出的表/列清单静默缺项，且无任何提示。
    const truncated = !options?.noTruncate && rows.length > QueryService.maxResultRows;
    if (truncated) rows = rows.slice(0, QueryService.maxResultRows);
    return { sql, costTime, rows, fields: fields || [], affectedRows, total, truncated, message: truncated ? `Results truncated to ${QueryService.maxResultRows} rows` : undefined };
  }
}
