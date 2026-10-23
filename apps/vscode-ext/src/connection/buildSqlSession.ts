/**
 * SQL 会话装配（从 `connectionManager.ts` 抽出，Phase 2 拆分）。
 *
 * 装配连接与四服务（query/metadata/data/table），并读取 MySQL sql_mode / PG
 * standard_conforming_strings 以切换方言变体；失败由调用方（doConnect）统一清理隧道。
 */
import {
  ConnectionFactory, QueryService, MetadataService, DataService, TableService,
  DialectRegistry, DatabaseType,
} from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { parseNoBackslashEscapes, parseStandardConformingStringsOff } from '@devbelt/db-core/sql';
import { QueryHistoryRecorder } from '../history/queryHistoryRecorder';
import { SshTunnel } from './sshTunnel';
import type { SqlConnectionSession } from './connectionSession';
import type { SessionBuildContext } from './sessionBuildContext';

export async function buildSqlSession(
  ctx: SessionBuildContext,
  conn: SavedConnection,
  host: string,
  port: number,
  generation: number,
  key: string,
  tunnelLease?: string,
): Promise<SqlConnectionSession> {
  const { connection, dialect } = ConnectionFactory.createWithDialect(
    conn.dbType as DatabaseType,
    sqlConnectionConfig(conn, host, port),
  );

  await new Promise<void>((resolve, reject) => {
    connection.connect((err) => (err ? reject(err) : resolve()));
  });

  // 建连期间用户关闭/删除该连接（或管理器整体销毁）：建成即销毁，
  // 绝不写入 sessions、绝不留下无人持有的连接与隧道。隧道由 doConnect 的
  // catch 统一关闭（此处只负责断开驱动连接）。
  if (ctx.disposing || ctx.generation(conn.id) !== generation) {
    connection.end();
    throw new Error('connection was closed before it could be established');
  }

  // 观察者挂在 QueryService 上，于是这条会话上**任何**修改性语句都会进历史，
  // 无论它来自编辑器、结果网格、表设计器还是树右键命令。
  const recorder = ctx.history ? new QueryHistoryRecorder(conn, ctx.history, (c) => ctx.scanOptionsFor(c)) : undefined;
  const query = new QueryService(connection, dialect, recorder?.observer(), conn.requestTimeout);

  // MySQL：读一次 @@sql_mode。NO_BACKSLASH_ESCAPES 会反转字符串转义语义，
  // 影响语句切分、只读判定与值转义；读失败不阻断建连，退回默认（反斜杠转义）。
  if (dialect.dbType === 'MYSQL') {
    try {
      const r = await query.query('SELECT @@sql_mode AS mode');
      const mode = String((r.rows?.[0] as { mode?: unknown } | undefined)?.mode ?? '');
      const nbe = parseNoBackslashEscapes(mode);
      ctx.setNoBackslashEscapes(conn.id, nbe);
      // 值转义按连接换用方言变体：各服务层在调用点取 query.dialect，替换即全局生效。
      query.setDialect(DialectRegistry.getFor(conn.dbType, { noBackslashEscapes: nbe }));
    } catch {
      /* 保持默认 */
    }
  }

  // PG：读一次 standard_conforming_strings。off 时普通 `'...'` 串里反斜杠是转义字符，
  // 影响语句切分与值转义；读失败不阻断建连，退回默认（on，PG 自 9.1 起默认）。
  if (dialect.dbType === 'PG') {
    try {
      const r = await query.query('SHOW standard_conforming_strings');
      const raw = String((r.rows?.[0] as { standard_conforming_strings?: unknown } | undefined)?.standard_conforming_strings ?? '');
      const off = parseStandardConformingStringsOff(raw);
      ctx.setPgStdOff(conn.id, off);
      query.setDialect(DialectRegistry.getFor(conn.dbType, { standardConformingStrings: !off }));
    } catch {
      /* 保持默认 */
    }
    try {
      // 记录主会话实际所在库：`conn.database` 为空时，树里该库节点按主会话键处理，避免重复建会话。
      const r = await query.query('SELECT current_database() AS db');
      const db = (r.rows?.[0] as { db?: unknown } | undefined)?.db;
      if (db) ctx.setPrimaryDb(conn.id, String(db));
    } catch {
      /* 保持未识别 */
    }
  }

  const session: SqlConnectionSession = {
    kind: 'sql',
    capabilities: dialect.capabilities,
    query,
    metadata: new MetadataService(query),
    data: new DataService(query),
    table: new TableService(query),
    isAlive: () => connection.isAlive(),
    close: () => {
      connection.end();
      ctx.forgetSession(key);
      // 仅当没有同连接其它会话时才清方言缓存（多库会话共享同连接配置）。
      if (!ctx.hasSessionForConn(conn.id)) {
        ctx.clearDialectCaches(conn.id);
        ctx.clearPrimaryDb(conn.id);
      }
      // 只释放本次引用：同连接其它库会话可能仍在使用共享隧道。
      if (conn.sshHost) SshTunnel.release(conn.id, tunnelLease);
    },
  };
  ctx.registerSession(key, session, {
    session,
    lastUsed: Date.now(),
    connId: conn.id,
    key,
    database: conn.dbType === DatabaseType.PG ? (conn.database ?? ctx.primaryDbOf(conn.id)) : undefined,
  });
  return session;
}

/** 组装方言连接工厂配置（buildSqlSession 与独立会话共用）。 */
export function sqlConnectionConfig(conn: SavedConnection, host: string, port: number) {
  return {
    host,
    port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    schema: conn.schema,
    timezone: conn.timezone,
    connectTimeout: conn.connectTimeout,
    requestTimeout: conn.requestTimeout,
    dbPath: conn.dbPath,
    // 只读在数据库层生效（见 ConnectionConfig.readOnly）；客户端拦截 confirmSqlExecution 仍保留。
    readOnly: conn.readOnly === true,
    useConnectionString: conn.useConnectionString,
    connectionUrl: conn.connectionUrl,
    useSSL: conn.useSSL,
    rejectUnauthorized: conn.rejectUnauthorized,
    caPath: conn.caPath,
    clientCertPath: conn.clientCertPath,
    clientKeyPath: conn.clientKeyPath,
    socketPath: conn.socketPath,
  };
}

/** 读一次会话级方言开关（MySQL sql_mode / PG scs），失败不阻断。不写任何缓存。 */
async function refineDialect(query: QueryService, conn: SavedConnection): Promise<void> {
  if (query.dialect.dbType === 'MYSQL') {
    try {
      const r = await query.query('SELECT @@sql_mode AS mode');
      const mode = String((r.rows?.[0] as { mode?: unknown } | undefined)?.mode ?? '');
      query.setDialect(DialectRegistry.getFor(conn.dbType, { noBackslashEscapes: parseNoBackslashEscapes(mode) }));
    } catch { /* 保持默认 */ }
  }
  if (query.dialect.dbType === 'PG') {
    try {
      const r = await query.query('SHOW standard_conforming_strings');
      const raw = String((r.rows?.[0] as { standard_conforming_strings?: unknown } | undefined)?.standard_conforming_strings ?? '');
      query.setDialect(DialectRegistry.getFor(conn.dbType, { standardConformingStrings: !parseStandardConformingStringsOff(raw) }));
    } catch { /* 保持默认 */ }
  }
}

/**
 * 装配一个**独立**（不进入连接池、不与面板/树共享）的 SQL 会话，供跨 schema 同步等
 * 需要独占连接的长事务使用，避免把其它面板的写入卷进同步事务（N1）。
 * 隧道由调用方创建并传入 `tunnelLease`；`close()` 时释放。调用方负责 `close()`。
 */
export async function openIsolatedSqlSession(
  conn: SavedConnection,
  host: string,
  port: number,
  tunnelLease?: string,
): Promise<{ session: SqlConnectionSession; close: () => void }> {
  const { connection, dialect } = ConnectionFactory.createWithDialect(
    conn.dbType as DatabaseType,
    sqlConnectionConfig(conn, host, port),
  );
  await new Promise<void>((resolve, reject) => {
    connection.connect((err) => (err ? reject(err) : resolve()));
  });
  const query = new QueryService(connection, dialect, undefined, conn.requestTimeout);
  await refineDialect(query, conn);
  let closed = false;
  const session: SqlConnectionSession = {
    kind: 'sql',
    capabilities: dialect.capabilities,
    query,
    metadata: new MetadataService(query),
    data: new DataService(query),
    table: new TableService(query),
    isAlive: () => connection.isAlive(),
    close: () => {
      // 幂等：多次调用只释放一次（避免重复释放 SSH 租约误关他人隧道）。
      if (closed) return;
      closed = true;
      connection.end();
      if (conn.sshHost) SshTunnel.release(conn.id, tunnelLease);
    },
  };
  return { session, close: () => session.close() };
}