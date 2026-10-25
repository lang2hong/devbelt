import { validateIdent, validateSchemaIdent, type QueryCancelToken } from '@devbelt/db-core';
import type { MonitorTask } from './monitorTypes';

/** 执行器用到的最小会话面（QueryService 结构性满足；测试可注入 fake）。 */
export interface MonitorQuerySession {
  query: {
    query(sql: string, values?: unknown, options?: { skipHistory?: boolean; token?: QueryCancelToken }): Promise<{ rows?: unknown[] }>;
    wrap(identifier: string): string;
  };
}

export interface OpenedMonitorSession {
  session: MonitorQuerySession;
  close(): void;
}

export interface MonitorExecutorDeps {
  /** 打开独立会话（不入池、不与面板共享）；连接类型/库由任务决定。 */
  openSession(task: MonitorTask): Promise<OpenedMonitorSession>;
  /** 任务所属连接的引擎（MYSQL / PG / SQLITE）。 */
  dbTypeOf(task: MonitorTask): string | undefined;
  timeoutMs: () => number;
  /** 会话空闲多久后关闭。 */
  idleCloseMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * A1 行数 SQL：表名 / schema 先校验再由方言加引号；SQLite 无 schema。
 * 标识符非法时抛错（任务创建时就会被拒绝，这里是第二道门）。
 */
export function buildRowCountSql(
  dbType: string,
  wrap: (identifier: string) => string,
  table: string,
  schema?: string,
): string {
  const engine = dbType.toUpperCase();
  const name = wrap(validateIdent(table));
  if (engine === 'PG' && schema) return `SELECT COUNT(*) AS n FROM ${wrap(validateSchemaIdent(schema))}.${name}`;
  return `SELECT COUNT(*) AS n FROM ${name}`;
}

/** 结果第一行第一列解析为非负有限数（mysql2 把 COUNT 返回成字符串，PG 可能是 bigint 字符串）。 */
export function parseCountRow(rows: unknown[] | undefined): number {
  const first = rows?.[0];
  if (!first || typeof first !== 'object') throw new Error('COUNT(*) returned no rows');
  const value = Object.values(first as Record<string, unknown>)[0];
  const n = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error(`COUNT(*) returned a non-numeric value: ${String(value)}`);
  return n;
}

interface CachedSession {
  opened: OpenedMonitorSession;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * 监控执行器：每个（连接 + 库 + schema）一个独立只读会话，任务串行，单次超时，
 * 空闲后关闭。不写查询历史（`skipHistory`），不调用模型。
 */
export class MonitorExecutor {
  private readonly sessions = new Map<string, CachedSession>();
  /** 同一（连接 + 库 + schema）上的任务串行执行：每个 key 一条 Promise 链。 */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly deps: MonitorExecutorDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** 执行一次，返回数值；失败抛错（调用方计入连续失败）。 */
  run(task: MonitorTask): Promise<number> {
    const dbType = this.deps.dbTypeOf(task);
    if (!dbType) return Promise.reject(new Error('connection not found'));
    if (task.kind !== 'rowCount') return Promise.reject(new Error(`unsupported monitor kind: ${task.kind}`));
    const key = `${task.connId}|${task.database ?? ''}|${task.schema ?? ''}`;
    const job = async (): Promise<number> => {
      const cached = await this.acquire(key, task, dbType);
      try {
        return await this.withTimeout(async (token) => {
          const sql = buildRowCountSql(dbType, (id) => cached.opened.session.query.wrap(id), task.table, task.schema);
          const result = await cached.opened.session.query.query(sql, undefined, { skipHistory: true, token });
          return parseCountRow(result?.rows);
        });
      } catch (err) {
        // 超时 / 连接断开后会话状态不可信：关掉，下次重开。
        this.closeSession(key);
        throw err;
      } finally {
        this.scheduleIdleClose(key);
      }
    };
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }

  /** 关闭全部会话（扩展停用 / 监控关闭）。 */
  dispose(): void {
    for (const key of [...this.sessions.keys()]) this.closeSession(key);
  }

  /** 某个连接的会话全部关闭（连接被删除或修改时）。 */
  closeConnection(connId: string): void {
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`${connId}|`)) this.closeSession(key);
  }

  private async acquire(key: string, task: MonitorTask, dbType: string): Promise<CachedSession> {
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.idleTimer) {
        this.clearTimer(existing.idleTimer);
        existing.idleTimer = undefined;
      }
      return existing;
    }
    const opened = await this.deps.openSession(task);
    try {
      await applyReadOnly(opened.session, dbType);
    } catch (err) {
      try { opened.close(); } catch { /* ignore */ }
      throw err;
    }
    const cached: CachedSession = { opened };
    this.sessions.set(key, cached);
    return cached;
  }

  private async withTimeout<T>(fn: (token: QueryCancelToken) => Promise<T>): Promise<T> {
    const token: QueryCancelToken = {};
    const ms = Math.max(1_000, this.deps.timeoutMs());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.setTimer(() => {
        token.cancel?.();
        reject(new Error(`monitor query timed out after ${Math.round(ms / 1000)}s`));
      }, ms);
    });
    try {
      return await Promise.race([fn(token), timeout]);
    } finally {
      if (timer) this.clearTimer(timer);
    }
  }

  private scheduleIdleClose(key: string): void {
    const cached = this.sessions.get(key);
    if (!cached) return;
    if (cached.idleTimer) this.clearTimer(cached.idleTimer);
    cached.idleTimer = this.setTimer(() => this.closeSession(key), this.deps.idleCloseMs ?? 10 * 60_000);
  }

  private closeSession(key: string): void {
    const cached = this.sessions.get(key);
    if (!cached) return;
    this.sessions.delete(key);
    if (cached.idleTimer) this.clearTimer(cached.idleTimer);
    try {
      cached.opened.close();
    } catch {
      // 已断开的会话关闭失败无需处理。
    }
  }
}

/** 数据库层只读（SQL 本身是 COUNT，这是第二道防线，和 Explain「实际执行」一致）。 */
export async function applyReadOnly(session: MonitorQuerySession, dbType: string): Promise<void> {
  const q = session.query;
  const opts = { skipHistory: true };
  const engine = dbType.toUpperCase();
  if (engine === 'MYSQL') await q.query('SET SESSION TRANSACTION READ ONLY', undefined, opts);
  else if (engine === 'PG') await q.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', undefined, opts);
  else if (engine === 'SQLITE') await q.query('PRAGMA query_only = ON', undefined, opts);
}
