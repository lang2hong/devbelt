import { IConnection } from '../connection/connection.js';
import type { SqlDialect } from '../dialect/sqlDialect.js';
import type { QueryCallback, QueryResult } from '../types/query.js';
import type { FieldInfo } from '../types/meta.js';

/**
 * 密码赋值的字面量。
 *
 * 覆盖 MySQL 的 `IDENTIFIED BY '…'` / `IDENTIFIED WITH plugin BY '…'` 与
 * PG 的 `[ENCRYPTED] PASSWORD '…'`（含 `WITH LOGIN PASSWORD`），以及
 * `SET PASSWORD = '…'`（`=` 形式，此前因关键字与字面量之间存在 `=` 而漏网）。
 * 匹配的是 **关键字 +（可选 `=`）+ 紧跟的字符串字面量** 这个结构，所以
 * `SELECT PASSWORD FROM legacy_users` 或备注里出现 "password" 都不会被误伤 ——
 * 报错里的 SQL 是主要排查线索，误伤等于把有用信息一起抹掉。
 *
 * 字面量内部允许 SQL 的双写转义（`''`）与反斜杠转义。
 */
const PASSWORD_LITERAL = new RegExp(
  String.raw`(\b(?:identified\s+with\s+\S+\s+as|identified\s+(?:with\s+\S+\s+)?by|set\s+password\s+for\s+[^\n;=]*|(?:encrypted\s+)?password)\s*=?\s*)`
  + String.raw`('(?:[^']|'')*'|"(?:[^"]|"")*")`,
  'gi',
);

/**
 * 抹掉 SQL 文本里的明文密码。
 *
 * 必须在 db-core 里做：上层有十几个 `catch (e) { show(e.message) }`，
 * 靠每一处自己记得脱敏是维持不住的。
 *
 * 这不是"多一层保险"—— 泄漏路径是实打实的：
 *  - MySQL 的语法错误会回显语句片段，形如
 *    `... check the manual ... near 'IDENTIFIED BY 'p@ss''`，密码里带个引号
 *    就足以触发，而这条 message 会被 post 到 webview 显示。
 *  - `QueryError.sql` 原样带着整条语句，任何日志、`JSON.stringify(err)`
 *    或将来的错误面板都会把它带出去。
 */
export function redactSql(sql: string | undefined): string | undefined {
  if (!sql) return sql;
  return sql.replace(PASSWORD_LITERAL, (_m, kw: string) => `${kw}'***'`);
}

/**
 * 查询错误封装：统一携带 SQL 与耗时，便于上层展示与排查。
 *
 * `sql` 与 `message` 在构造时就脱敏，调用方拿到的对象里不存在明文密码 ——
 * 而不是要求每个展示点自己记得处理。
 */
export class QueryError extends Error {
  readonly sql?: string;

  constructor(
    message: string,
    sql?: string,
    public readonly costTime: number = 0,
  ) {
    super(redactSql(message) ?? message);
    this.sql = redactSql(sql);
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
  /**
   * 本查询的单独取消句柄。`query()` 会把该次查询的 cancel 接到此对象的
   * `cancel` 上，调用方据此只取消自己这一条查询，而不牵连同一会话上的
   * 其它在途查询（元数据/补全/其它面板）。
   */
  token?: QueryCancelToken;
}

/** 由调用方传入、`query()` 回填的可取消句柄。 */
export interface QueryCancelToken {
  cancel?: () => void;
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
  dialect: SqlDialect;
  /** 在途查询的取消句柄（多槽，支持并发查询各自取消）。 */
  private readonly activeCancels = new Map<number, () => void>();
  private nextQueryId = 1;
  /**
   * 会话是否处于显式事务中（best-effort，按语句首关键字跟踪）。
   * 供连接池淘汰判断：**有未结束事务的会话不能被淘汰**（会静默回滚/丢未提交数据）。
   */
  private txActive = false;
  /** 事务状态版本号：每次事务状态变化自增，用于失败回滚时避免覆盖并发语句的更新。 */
  private txEpoch = 0;

  constructor(
    private readonly connection: IConnection,
    dialect: SqlDialect,
    /** 可选语句观察者（vscode-ext 用它写查询历史）。 */
    private readonly observer?: QueryObserver,
    /**
     * 本次会话的查询超时（ms，0 = 不超时）。缺省回落到静态 `queryTimeout`。
     * 让每个连接可用各自的 `requestTimeout` 覆盖全局默认（MySQL/SQLite 过去完全无效）。
     */
    private readonly timeoutMsOverride?: number,
  ) {
    this.dialect = dialect;
  }

  /** 生效的查询超时：会话级覆盖优先，否则全局默认。 */
  private get timeoutMs(): number {
    return this.timeoutMsOverride ?? QueryService.queryTimeout;
  }

  /** 是否处于显式事务中（best-effort；连接池淘汰据此保护）。 */
  get inTransaction(): boolean {
    return this.txActive;
  }

  /** 去掉前导注释后的语句首部（事务识别用）。 */
  private statementHead(sql: string): string {
    return sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, '').trimStart();
  }

  /** 该语句是否用于**开启**事务（BEGIN/START TRANSACTION 或 SET AUTOCOMMIT=0）。 */
  private isTxOpeningStatement(sql: string): boolean {
    const head = this.statementHead(sql);
    return /^(BEGIN|START\s+TRANSACTION)\b/i.test(head) || /^SET\s+AUTOCOMMIT\s*=\s*0\b/i.test(head);
  }

  /** 按语句首关键字更新事务状态（近似：多语句脚本按整体首关键字判断）。 */
  private trackTransaction(sql: string): void {
    const head = this.statementHead(sql);
    if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(head)) this.txActive = true;
    // `ROLLBACK TO [SAVEPOINT]` 只回滚到保存点，事务仍活跃，不能当作事务结束（H5）。
    else if (/^(COMMIT|END)\b/i.test(head) || (/^ROLLBACK\b/i.test(head) && !/^ROLLBACK\s+TO\b/i.test(head)) || /^ABORT\b/i.test(head)) this.txActive = false;
    else if (/^SET\s+AUTOCOMMIT\s*=\s*0\b/i.test(head)) this.txActive = true;
    else if (/^SET\s+AUTOCOMMIT\s*=\s*1\b/i.test(head)) this.txActive = false;
    else return;
    this.txEpoch++;
  }

  /**
   * 替换本次会话的方言实例。
   *
   * 连接层读到 `@@sql_mode` 含 NO_BACKSLASH_ESCAPES 后，换用不做反斜杠转义的
   * MySQL 方言变体。各服务层都在调用点取 `queryService.dialect`，故替换对全部
   * 值转义（data/table/backup/dataDiff/keyset）一次性生效。
   */
  setDialect(dialect: SqlDialect): void {
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
  /** 全局默认查询超时（ms）。默认 300 秒；宿主（vscode-ext）用 `devbelt.sql.queryTimeoutSeconds` 实时覆盖，连接级 `requestTimeout` 优先于本值。 */
  static queryTimeout = 300_000;
  /** Maximum number of rows retained in an arbitrary query result. */
  static maxResultRows = 10_000;

  async query(sql: string, values?: any, options?: QueryOptions): Promise<QueryResult> {
    if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
      throw new QueryError('SQL statement cannot be empty');
    }
    const txBefore = this.txActive;
    const opensTx = this.isTxOpeningStatement(sql);
    this.trackTransaction(sql);
    const txEpochAfter = this.txEpoch;
    // 失败时复位：仅当此后没有其它语句改过事务状态（epoch 未变），避免并发场景覆盖他人更新。
    const restoreTx = (): void => {
      if (opensTx && this.txEpoch === txEpochAfter) this.txActive = txBefore;
    };
    const start = Date.now();
    const id = this.nextQueryId++;
    return new Promise<QueryResult>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (this.activeCancels.get(id) === cancelReject) this.activeCancels.delete(id);
        // 清空回填的 handle：查询结束后残留的 cancel 一旦被调用会误 abort 连接上
        // 正在执行的**其他**查询（abortQuery 是连接级的）。
        if (options?.token && options.token.cancel === tokenCancel) options.token.cancel = undefined;
        if (timer) clearTimeout(timer);
      };
      // 只负责“拒绝并清理”，物理中止由调用方统一发起（见 cancel()/token），
      // 避免会话级取消时对同一物理连接发起 N 次 abort。
      const cancelReject = (): void => {
        if (settled) return;
        settled = true;
        finish();
        // BEGIN 未成功（取消/错误）→ 复位，否则该会话被误判为「事务中」而永不淘汰。
        restoreTx();
        reject(new QueryError('Query cancelled', sql, Date.now() - start));
      };
      // 单查询取消：仅当这次查询仍在活跃集合中才物理中止，避免陈旧 token 牵连他人。
      const tokenCancel = (): void => {
        if (!this.activeCancels.has(id)) return;
        cancelReject();
        this.connection.abortQuery();
      };
      this.activeCancels.set(id, cancelReject);
      if (options?.token) {
        options.token.cancel = tokenCancel;
      }
      const timeoutMs = this.timeoutMs;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (!settled) {
              // 超时是独立终态：直接以 timeout 文案结算，不经过 cancelReject（后者会改成 "cancelled"）。
              settled = true;
              finish();
              this.connection.abortQuery();
              restoreTx();
              reject(new QueryError(`Query timeout (${timeoutMs}ms)`, sql, Date.now() - start));
            }
          }, timeoutMs)
        : null;
      const callback: QueryCallback = (err, results, fields) => {
        if (settled) return;
        settled = true;
        finish();
        const costTime = Date.now() - start;
        if (err) {
          this.notifyObserver(
            { sql: redactSql(sql)!, costTime, rowCount: 0, error: redactSql(err.message) },
            options,
          );
          // BEGIN 报错（如已在事务中/连接错误）→ 事务状态复位到执行前，避免会话被永久保护。
          restoreTx();
          reject(new QueryError(err.message, sql, costTime));
          return;
        }
        const result = this.normalizeResult(sql, results, fields || [], costTime, options);
        this.notifyObserver(
          { sql: redactSql(sql)!, costTime, rowCount: result.rows.length, affectedRows: result.affectedRows },
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
    // cancel 闭包只拒绝并清理；物理中止对整条连接只发一次。
    for (const cancelFn of [...this.activeCancels.values()]) cancelFn();
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
    // 入参可能来自 UI/计算路径，可能为 NaN/负数/小数/超大值；方言的 getPagedSql 是直接内插，
    // 必须先归一为合法整数，否则会拼出非法 SQL（`LIMIT NaN`）或意外的行数。
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : QueryService.maxResultRows;
    // 分页读取（导出、备份、数据对比）同样不进历史。
    return this.query(this.dialect.getPagedSql(sql, safeOffset, safeLimit), undefined, { skipHistory: true });
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
    /**
     * 结果里的 sql 一并脱敏。
     *
     * 唯一的消费者是 rowEditor（拿原 SELECT 解析表名以构造 UPDATE），而 SELECT
     * 不含密码字面量、不会被脱敏规则匹配到 —— 所以这里没有功能代价，
     * 换来的是"任何流出 db-core 的 SQL 文本都已脱敏"这一条统一的保证，
     * 不必逐个消费点判断该不该处理。
     */
    return { sql: redactSql(sql)!, costTime, rows, fields: fields || [], affectedRows, total, truncated, message: truncated ? `Results truncated to ${QueryService.maxResultRows} rows` : undefined };
  }
}
