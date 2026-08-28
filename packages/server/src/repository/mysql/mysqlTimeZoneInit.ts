import type { MysqlDb } from './db.js';

/**
 * 让连接池每建立一条连接都初始化 UTC 会话时区（实施规格 §4.2：
 * 「migration 与每个 MySQL pool connection 初始化必须执行 SET time_zone = '+00:00'」）。
 *
 * @fastify/mysql 不暴露 per-connection init SQL 选项，但把底层 mysql2 pool
 * 挂在 `db.pool` 上，可用其 'connection' 事件钩住每条新建连接。
 *
 * 该调用与 mysqlPool.ts 的 `timezone: 'Z'` 是两回事：后者是 mysql2 对 Date 的
 * 序列化时区（客户端层），这里是 MySQL 会话的 `NOW()/CURRENT_TIMESTAMP` 语义
 * （服务端层）。两者都与 UTC 对齐后，DATETIME(3) 才不依赖宿主/DB 时区。
 */
export function mysqlTimeZoneInit(db: MysqlDb): void {
  const pool = (db as unknown as { pool?: { on?: (ev: string, cb: (conn: unknown) => void) => void } }).pool;
  if (!pool || typeof pool.on !== 'function') return;
  pool.on('connection', (conn) => {
    try {
      const q = (conn as { query?: (sql: string) => unknown }).query?.call(conn, "SET time_zone = '+00:00'");
      if (q && typeof (q as Promise<unknown>).catch === 'function') {
        void (q as Promise<unknown>).catch(() => {});
      }
    } catch {
      // 单条连接初始化失败不阻断建连；时区偏差仅影响连接自身的 NOW() 语义。
    }
  });
}