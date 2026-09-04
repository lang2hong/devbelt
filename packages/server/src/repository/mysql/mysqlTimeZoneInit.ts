import type { MysqlDb } from './db.js';

/**
 * 让连接池的**每一条**连接都初始化 UTC 会话时区（实施规格 §2：
 * 「migration 与每个 MySQL pool connection 初始化必须执行 SET time_zone = '+00:00'」）。
 *
 * 该调用与 mysqlPool.ts 的 `timezone: 'Z'` 是两回事：后者是 mysql2 对 Date 的
 * 序列化时区（客户端层），这里是 MySQL 会话的 `NOW()/CURRENT_TIMESTAMP` 语义
 * （服务端层）。两者都与 UTC 对齐后，DATETIME(3) 才不依赖宿主/DB 时区。
 *
 * 修正的两个缺陷：
 *
 * 1. **漏掉池的第一条连接**。`@fastify/mysql` 在插件启动时会跑一次探活查询
 *    （`SELECT NOW()`），那条连接在本函数挂上监听器**之前**就已创建并触发过
 *    'connection' 事件，因此永远不会执行 SET。mysql2 取空闲连接是 LIFO，
 *    低流量部署下这条未初始化的连接恰好承担大部分查询 —— 于是
 *    `DEFAULT CURRENT_TIMESTAMP(3)` 与 `expires_time > NOW(3)` 全部按服务器
 *    会话时区计算。在 +08:00 的实例上，24h 的 sync-reset token 会早 8 小时失效。
 *    做法：除挂事件外，**再对池中已存在的连接补一次**（借出→SET→归还）。
 *
 * 2. **错误处理不生效**。事件回调拿到的是 mysql2 原始的回调式
 *    `PoolConnection`（promise 包装器会把底层参数原样透传），`conn.query(sql)`
 *    不传 callback 时返回的是 `Query` 命令对象而**不是** Promise，所以原先的
 *    `.catch` 分支永远不会命中，`try/catch` 也看不到异步失败。命令对象在出错时
 *    emit 'error'，无监听者即成为未捕获异常 → **进程退出**，与注释宣称的
 *    「单条连接初始化失败不阻断建连」正好相反。
 *    做法：显式传 callback（回调式 API 的错误由回调参数返回，不会 emit）。
 */

const SET_UTC = "SET time_zone = '+00:00'";

type RawConn = {
  query?: (sql: string, cb: (err: unknown) => void) => unknown;
};

/** 在一条原始连接上执行 SET，错误只吞掉（不阻断建连、不冒泡成未捕获异常）。 */
function initConnection(conn: unknown): void {
  const q = (conn as RawConn)?.query;
  if (typeof q !== 'function') return;
  try {
    // 传 callback：回调式 API 通过回调参数返回错误，不会 emit 'error'。
    q.call(conn, SET_UTC, () => {});
  } catch {
    // 同步抛出（连接已销毁等）同样忽略。
  }
}

export function mysqlTimeZoneInit(db: MysqlDb): void {
  const pool = (db as unknown as {
    pool?: {
      on?: (ev: string, cb: (conn: unknown) => void) => void;
      getConnection?: (cb: (err: unknown, conn: unknown) => void) => void;
    };
  }).pool;
  if (!pool || typeof pool.on !== 'function') return;

  // 后续新建的连接。
  pool.on('connection', (conn) => initConnection(conn));

  // 插件探活时已建立的连接（不会再触发 'connection'）：借出来补设一次。
  // 池中可能已有多条空闲连接，逐条借出会互相错开，这里只保证「至少覆盖探活那条」；
  // 其余连接若是后来新建的，已由上面的事件覆盖。
  if (typeof pool.getConnection === 'function') {
    try {
      pool.getConnection((err, conn) => {
        if (err || !conn) return;
        initConnection(conn);
        (conn as { release?: () => void }).release?.();
      });
    } catch {
      // 取连接失败不阻断启动。
    }
  }
}
