/**
 * 连接池类型与常量（从 `connectionManager.ts` 抽出，Phase 2 拆分）。
 * 供 connectionManager 与 session 装配模块共用，避免类型环依赖。
 */
import type { ConnectionSession } from './connectionSession';

export interface PoolConfig {
  maxConnections: number;
  idleTimeoutMs: number;
  healthCheckIntervalMs: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxConnections: 10,
  idleTimeoutMs: 300_000,
  healthCheckIntervalMs: 60_000,
};

export interface SessionEntry {
  session: ConnectionSession;
  lastUsed: number;
  connId: string;
  /** 会话键：主会话 = connId；PG 衍生库会话 = `${connId}\u0000${database}`。 */
  key: string;
  /** 该会话绑定的库（仅 PG 衍生会话；主会话为连接配置库/undefined）。 */
  database?: string;
}

/** B2：单个连接最多可同时保留的**衍生库会话**数（不含主会话）。 */
export const DERIVED_DB_SESSION_MAX = 4;

/** 会话键里的连接/库分隔符（UUID 与库名都不会出现）。 */
export const SESSION_KEY_SEP = '\u0000';