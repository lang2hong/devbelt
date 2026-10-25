import { validateIdent, validateSchemaIdent, type QueryCancelToken } from '@devbelt/db-core';
import type { AgentEngine } from '@devbelt/agent-core';
import { checkMetricResult, checkMetricSql } from './monitorValidate';
import { MAX_CURSOR_SEEN, NEW_ROWS_LIMIT, type MonitorRunResult, type MonitorTask } from './monitorTypes';

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
  openSession(task: Pick<MonitorTask, 'connId' | 'database' | 'schema'>): Promise<OpenedMonitorSession>;
  /** 任务所属连接的引擎（MYSQL / PG / SQLITE）。 */
  dbTypeOf(task: Pick<MonitorTask, 'connId'>): string | undefined;
  timeoutMs: () => number;
  /** 会话空闲多久后关闭。 */
  idleCloseMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** 一次执行的完整结果：在 MonitorRunResult 之上附带只放内存的新增行。 */
export interface MonitorExecution extends MonitorRunResult {
  /** B：本次新增的行（≤ 50，只放内存，不落盘、默认不发给模型）。 */
  rows?: Array<Record<string, unknown>>;
  /** B：还有更多新行（本次只取回前 50 行）。 */
  more?: boolean;
}

function engineOf(dbType: string): AgentEngine {
  const engine = dbType.toUpperCase();
  if (engine === 'MYSQL' || engine === 'PG' || engine === 'SQLITE') return engine;
  throw new Error(`unsupported engine: ${dbType}`);
}

/** `<schema>.<table>`（PG 有 schema 时）或 `<table>`；标识符先校验再由方言加引号。 */
export function qualifiedTable(dbType: string, wrap: (identifier: string) => string, table: string, schema?: string): string {
  const name = wrap(validateIdent(table));
  return dbType.toUpperCase() === 'PG' && schema ? `${wrap(validateSchemaIdent(schema))}.${name}` : name;
}

/**
 * A1 行数 SQL：表名 / schema 先校验再由方言加引号；SQLite 无 schema。
 * 标识符非法时抛错（任务创建时就会被拒绝，这里是第二道门）。
 */
export function buildRowCountSql(dbType: string, wrap: (identifier: string) => string, table: string, schema?: string): string {
  return `SELECT COUNT(*) AS n FROM ${qualifiedTable(dbType, wrap, table, schema)}`;
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

/** SQLite CLI 驱动不支持参数绑定：游标只允许整数，并在内插前严格校验。 */
function sqliteIntegerLiteral(value: string): string {
  if (!/^-?\d{1,20}$/.test(value)) throw new Error('invalid cursor value');
  return value;
}

/** 占位符：MySQL `?`，PG `$1`，SQLite 内插整数字面量（无绑定）。 */
function cursorPredicate(dbType: string, column: string, op: '>=' | '>', value: string): { where: string; params?: unknown[] } {
  const engine = dbType.toUpperCase();
  if (engine === 'SQLITE') return { where: `${column} ${op} ${sqliteIntegerLiteral(value)}` };
  if (engine === 'PG') return { where: `${column} ${op} $1`, params: [value] };
  return { where: `${column} ${op} ?`, params: [value] };
}

/** 游标值 / 主键值的字符串形式（与驱动返回格式一致：MySQL dateStrings、PG 原样）。 */
function cellString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function pkKey(row: Record<string, unknown>, primaryKey: readonly string[]): string {
  return JSON.stringify(primaryKey.map((c) => cellString(row[c])));
}

/** B 的查询：`WHERE c >= cursor ORDER BY c, pk… LIMIT 51 + 已见`；无主键时用 `>`。 */
export function buildNewRowsSql(
  dbType: string,
  wrap: (identifier: string) => string,
  task: Pick<MonitorTask, 'table' | 'schema' | 'cursorColumn' | 'primaryKey' | 'cursorValue' | 'cursorSeen'>,
): { sql: string; params?: unknown[]; limit: number } {
  if (!task.cursorColumn) throw new Error('cursor column missing');
  const from = qualifiedTable(dbType, wrap, task.table, task.schema);
  const cursor = wrap(validateIdent(task.cursorColumn));
  const pk = (task.primaryKey ?? []).map((c) => wrap(validateIdent(c)));
  const seen = task.cursorSeen?.length ?? 0;
  const limit = NEW_ROWS_LIMIT + 1 + (pk.length > 0 ? seen : 0);
  const order = [cursor, ...pk].join(', ');
  if (task.cursorValue === undefined) return { sql: `SELECT * FROM ${from} ORDER BY ${order} LIMIT ${limit}`, limit };
  const predicate = cursorPredicate(dbType, cursor, pk.length > 0 ? '>=' : '>', task.cursorValue);
  return { sql: `SELECT * FROM ${from} WHERE ${predicate.where} ORDER BY ${order} LIMIT ${limit}`, ...(predicate.params ? { params: predicate.params } : {}), limit };
}

/**
 * 游标推进（纯函数）：去掉已见的行，取前 50 行作为新增；游标推进到取回的最后一个游标值，
 * 已见集合是该游标值上的主键。无主键时只推进游标（`>` 语义）。
 */
export function advanceCursor(
  task: Pick<MonitorTask, 'cursorColumn' | 'primaryKey' | 'cursorValue' | 'cursorSeen'>,
  rows: ReadonlyArray<Record<string, unknown>>,
): { added: Array<Record<string, unknown>>; more: boolean; cursor?: { value: string; seen: string[] } } {
  const column = task.cursorColumn!;
  const pk = task.primaryKey ?? [];
  const seen = new Set(task.cursorSeen ?? []);
  const fresh = rows.filter((row) => !(pk.length > 0 && cellString(row[column]) === task.cursorValue && seen.has(pkKey(row, pk))));
  const more = fresh.length > NEW_ROWS_LIMIT;
  const added = fresh.slice(0, NEW_ROWS_LIMIT);
  if (added.length === 0) return { added, more: false };
  const value = cellString(added[added.length - 1]![column]);
  if (pk.length === 0) return { added, more, cursor: { value, seen: [] } };
  // 新游标值上的主键：本次新增的 + 之前已见的（游标值没变时）。
  const nextSeen = new Set(value === task.cursorValue ? seen : []);
  for (const row of added) if (cellString(row[column]) === value) nextSeen.add(pkKey(row, pk));
  return { added, more, cursor: { value, seen: [...nextSeen].slice(-MAX_CURSOR_SEEN) } };
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

  /** 执行一次；失败抛错（调用方计入连续失败）。 */
  run(task: MonitorTask): Promise<MonitorExecution> {
    const dbType = this.deps.dbTypeOf(task);
    if (!dbType) return Promise.reject(new Error('connection not found'));
    return this.withSession(task, dbType, (session, token) => executeTask(session, dbType, task, token));
  }

  /**
   * 在任务的只读会话上执行任意只读操作（创建前的试执行 / 取游标基线）。
   * 与定时任务共享串行链与超时。
   */
  trial<T>(
    target: Pick<MonitorTask, 'connId' | 'database' | 'schema'>,
    fn: (session: MonitorQuerySession, token: QueryCancelToken, dbType: string) => Promise<T>,
  ): Promise<T> {
    const dbType = this.deps.dbTypeOf(target);
    if (!dbType) return Promise.reject(new Error('connection not found'));
    return this.withSession(target, dbType, (session, token) => fn(session, token, dbType));
  }

  /** 关闭全部会话（扩展停用 / 监控关闭）。 */
  dispose(): void {
    for (const key of [...this.sessions.keys()]) this.closeSession(key);
  }

  /** 某个连接的会话全部关闭（连接被删除或修改时）。 */
  closeConnection(connId: string): void {
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`${connId}|`)) this.closeSession(key);
  }

  private withSession<T>(
    target: Pick<MonitorTask, 'connId' | 'database' | 'schema'>,
    dbType: string,
    fn: (session: MonitorQuerySession, token: QueryCancelToken) => Promise<T>,
  ): Promise<T> {
    const key = `${target.connId}|${target.database ?? ''}|${target.schema ?? ''}`;
    const job = async (): Promise<T> => {
      const cached = await this.acquire(key, target, dbType);
      try {
        return await this.withTimeout((token) => fn(cached.opened.session, token));
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

  private async acquire(key: string, target: Pick<MonitorTask, 'connId' | 'database' | 'schema'>, dbType: string): Promise<CachedSession> {
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.idleTimer) {
        this.clearTimer(existing.idleTimer);
        existing.idleTimer = undefined;
      }
      return existing;
    }
    const opened = await this.deps.openSession(target);
    try {
      await applyReadOnly(opened.session, dbType, target.schema);
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

/** 按任务类型执行一次（会话已只读）。 */
export async function executeTask(
  session: MonitorQuerySession,
  dbType: string,
  task: MonitorTask,
  token: QueryCancelToken,
): Promise<MonitorExecution> {
  const q = session.query;
  const opts = { skipHistory: true, token };
  const wrap = (id: string) => q.wrap(id);
  if (task.kind === 'rowCount') {
    const result = await q.query(buildRowCountSql(dbType, wrap, task.table, task.schema), undefined, opts);
    return { value: parseCountRow(result?.rows) };
  }
  if (task.kind === 'metric') {
    if (!task.sql) throw new Error('metric SQL missing');
    // 每次执行前重新过门禁：任务文件被手工改动也不能变成写语句。
    const check = checkMetricSql(task.sql, engineOf(dbType));
    if (!check.ok) throw new Error(`metric SQL rejected: ${check.issue.code}`);
    const result = await q.query(check.statement, undefined, opts);
    const shape = checkMetricResult(result?.rows, task.watchColumn);
    if (!shape.ok) throw new Error(`metric result invalid: ${shape.issues.map((i) => i.code + (i.detail ? `(${i.detail})` : '')).join(', ')}`);
    return { value: shape.values![shape.watchColumn!] ?? null, values: shape.values! };
  }
  if (task.kind === 'newRows') {
    const { sql, params } = buildNewRowsSql(dbType, wrap, task);
    const result = await q.query(sql, params, opts);
    const rows = (Array.isArray(result?.rows) ? result.rows : []) as Array<Record<string, unknown>>;
    const advanced = advanceCursor(task, rows);
    if (!advanced.more) {
      return {
        value: advanced.added.length,
        rows: advanced.added,
        more: false,
        ...(advanced.cursor ? { cursor: advanced.cursor } : {}),
      };
    }
    // 超过 50 行：数一次总数作为本次新增，游标直接跳到当前最大值，
    // 下一次不会把剩下的行再算一遍（只展示前 50 行）。
    const from = qualifiedTable(dbType, wrap, task.table, task.schema);
    const cursor = wrap(validateIdent(task.cursorColumn!));
    let total = advanced.added.length;
    if (task.cursorValue !== undefined) {
      const predicate = cursorPredicate(dbType, cursor, (task.primaryKey?.length ?? 0) > 0 ? '>=' : '>', task.cursorValue);
      const counted = await q.query(`SELECT COUNT(*) AS n FROM ${from} WHERE ${predicate.where}`, predicate.params, opts);
      total = Math.max(total, parseCountRow(counted?.rows) - (task.cursorSeen?.length ?? 0));
    } else {
      total = Math.max(total, parseCountRow((await q.query(`SELECT COUNT(*) AS n FROM ${from}`, undefined, opts))?.rows));
    }
    const jumped = await readCursorBaseline(session, dbType, task, token);
    return {
      value: total,
      rows: advanced.added,
      more: true,
      ...(jumped ? { cursor: jumped } : advanced.cursor ? { cursor: advanced.cursor } : {}),
    };
  }
  throw new Error(`unsupported monitor kind: ${(task as MonitorTask).kind}`);
}

/**
 * B 的基线：当前 `MAX(cursor)` 与该值上的主键（创建时取一次；只看「之后」）。
 * 空表返回 undefined（之后的所有行都算新增）。
 */
export async function readCursorBaseline(
  session: MonitorQuerySession,
  dbType: string,
  task: Pick<MonitorTask, 'table' | 'schema' | 'cursorColumn' | 'primaryKey'>,
  token: QueryCancelToken,
): Promise<{ value: string; seen: string[] } | undefined> {
  const q = session.query;
  const wrap = (id: string) => q.wrap(id);
  const opts = { skipHistory: true, token };
  const from = qualifiedTable(dbType, wrap, task.table, task.schema);
  const cursor = wrap(validateIdent(task.cursorColumn!));
  const max = await q.query(`SELECT MAX(${cursor}) AS v FROM ${from}`, undefined, opts);
  const raw = (max?.rows?.[0] as Record<string, unknown> | undefined)?.v;
  if (raw === null || raw === undefined) return undefined;
  const value = cellString(raw);
  const pk = task.primaryKey ?? [];
  if (pk.length === 0) return { value, seen: [] };
  const predicate = cursorPredicate(dbType, cursor, '>=', value);
  const cols = pk.map((c) => wrap(validateIdent(c))).join(', ');
  const rows = await q.query(`SELECT ${cols}, ${cursor} FROM ${from} WHERE ${predicate.where} ORDER BY ${cols} LIMIT ${MAX_CURSOR_SEEN}`, predicate.params, opts);
  const list = (Array.isArray(rows?.rows) ? rows.rows : []) as Array<Record<string, unknown>>;
  return { value, seen: list.filter((r) => cellString(r[task.cursorColumn!]) === value).map((r) => pkKey(r, pk)) };
}

/**
 * 数据库层只读（第二道防线，和 Explain「实际执行」一致）；PG 指定 schema 时设置 search_path，
 * 让 A2 的未限定表名解析到该 schema。
 */
export async function applyReadOnly(session: MonitorQuerySession, dbType: string, schema?: string): Promise<void> {
  const q = session.query;
  const opts = { skipHistory: true };
  const engine = dbType.toUpperCase();
  if (engine === 'MYSQL') await q.query('SET SESSION TRANSACTION READ ONLY', undefined, opts);
  else if (engine === 'PG') {
    await q.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', undefined, opts);
    if (schema) await q.query(`SET search_path TO ${q.wrap(validateSchemaIdent(schema))}, public`, undefined, opts);
  } else if (engine === 'SQLITE') await q.query('PRAGMA query_only = ON', undefined, opts);
}
