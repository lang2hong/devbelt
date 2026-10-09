/**
 * 会话装配上下文（Phase 2 拆分）。
 *
 * `buildRedisSession` / `buildSqlSession` 通过此接口回调 `ConnectionManager` 的
 * 会话注册、淘汰与连接级方言缓存，而不直接依赖管理器内部字段。
 */
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { SqlScanOptions } from '@devbelt/db-core/sql';
import type { HistoryStore } from '../history/historyStore';
import type { ConnectionSession } from './connectionSession';
import type { SessionEntry } from './poolTypes';

export interface SessionBuildContext {
  /** 管理器是否正在整体销毁（装配期间需据此自毁）。 */
  readonly disposing: boolean;
  /** 连接代际（未记录为 0）。 */
  generation(connId: string): number;
  /** 该连接适用的 SQL 扫描选项（MySQL sql_mode / PG standard_conforming_strings）。 */
  scanOptionsFor(conn: SavedConnection): SqlScanOptions;
  /** 查询历史（可选）；传入后修改性语句自动入历史。 */
  readonly history?: HistoryStore;
  /** cluster over SSH 未映射节点回调。 */
  onRedisNodeUnmapped?: (connId: string, address: string) => void;

  /** 会话入池（含 disposing 自毁与建后 LRU 淘汰）。 */
  registerSession(key: string, session: ConnectionSession, entry: SessionEntry): void;
  /** 该连接是否仍有已缓存会话（多库衍生场景）。 */
  hasSessionForConn(connId: string): boolean;
  /** 从池中移除会话键（会话 close 时调用）。 */
  forgetSession(key: string): void;
  /** 清连接级方言缓存（MySQL/PG 模式）。 */
  clearDialectCaches(connId: string): void;
  /** 清主会话库识别缓存。 */
  clearPrimaryDb(connId: string): void;
  setNoBackslashEscapes(connId: string, value: boolean): void;
  setPgStdOff(connId: string, value: boolean): void;
  setPrimaryDb(connId: string, value: string): void;
  primaryDbOf(connId: string): string | undefined;
}