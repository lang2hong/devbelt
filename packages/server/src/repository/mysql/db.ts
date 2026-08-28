/**
 * MySQL 连接的惰性访问类型。
 * repository 实现通过 getter 获取连接（app.ready 后才有值），
 * 使 createApp 可在路由注册阶段就构造 repo，运行时才取连接。
 */
export type MysqlDb = {
  database: string;
  query<T = any>(sql: string, params?: any[]): Promise<T>;
  /**
   * 从池里借一条连接。事务必须跑在**同一条连接**上 ——
   * 池的 `query()` 每次可能拿到不同连接，`BEGIN` 和 `COMMIT` 落到两条连接上
   * 等于什么都没做（还会把一条连接永久留在未提交状态）。
   */
  getConnection(): Promise<MysqlTx>;
};

/** 一条借出的连接：可开事务，用完必须 release 回池 */
export type MysqlTx = {
  query<T = any>(sql: string, params?: any[]): Promise<T>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
};

/**
 * 可执行 SQL 的最小接口。repository 的事务方法接受它（而非具体连接类型），
 * 使同一方法既能在池连接上执行，也能在事务里执行。
 * 服务层通过 TxRunner 拿到它而不感知底层连接。
 */
export type Queryable = {
  query<T = any>(sql: string, params?: any[]): Promise<T>;
};

/**
 * 事务执行器（服务层依赖此抽象发起跨仓储事务）。
 *
 * - 生产/真库装配：`(fn) => withTransaction(db, fn)`。
 * - 测试装配：内存假仓储天然原子，可用 `(fn) => fn(dummy)` 直接执行。
 */
export type TxRunner = <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;

/**
 * 在单条连接的事务里执行一组语句：成功 COMMIT，抛错 ROLLBACK，无论如何 RELEASE。
 *
 * 三个容易漏掉的点，都在这里兜住：
 *
 * 1. **release 必须在 finally**。忘了归还连接，池会被一次次借出而永不释放，
 *    达到 connectionLimit 后所有请求卡在获取超时上 —— 表现为「服务突然全挂」，
 *    且与最初出错的那个请求已经隔开很久，极难定位。
 * 2. **ROLLBACK 自身也会失败**（连接已断时最典型）。这里吞掉回滚的错误并抛出
 *    原始错误：连接断了本来就意味着事务不会提交，而调用方需要看到的是业务
 *    错误，不是「rollback 时 socket 已关闭」。
 * 3. **COMMIT 失败同样要 release**。COMMIT 抛错时事务已经结束（成或败由
 *    server 决定），此处不再补一次 ROLLBACK，只把错误抛出去。
 *
 * 刻意不提供「嵌套事务」：MySQL 没有真正的嵌套事务，内层 COMMIT 会把外层
 * 一起提交。需要跨仓储的原子性时应该把连接显式传进去，而不是靠这个函数嵌套。
 */
export async function withTransaction<T>(db: MysqlDb, fn: (tx: MysqlTx) => Promise<T>): Promise<T> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    let result: T;
    try {
      result = await fn(conn);
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        // 回滚失败不能掩盖原始错误：调用方要的是业务错误本身
      }
      throw err;
    }
    await conn.commit();
    return result;
  } finally {
    conn.release();
  }
}
