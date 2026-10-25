/**
 * P13 数据监控：任务模型与纯函数规则（零 vscode 依赖，便于单测）。
 *
 * 第一批只实现 A1（行数）；A2 / B 的类型先占位，执行器拒绝未实现的类型。
 */

export type MonitorKind = 'rowCount';

export type MonitorStatus = 'running' | 'paused' | 'error';

/** 提醒条件：与上一次结果比较（变化类）或与固定值比较（阈值类）。 */
export type MonitorCondition =
  | { type: 'anyChange' }
  | { type: 'increaseBy'; value: number }
  | { type: 'decreaseBy'; value: number }
  | { type: 'changePercent'; value: number }
  | { type: 'above'; value: number }
  | { type: 'below'; value: number };

export interface MonitorTask {
  id: string;
  kind: MonitorKind;
  connId: string;
  database?: string;
  schema?: string;
  table: string;
  intervalMs: number;
  condition: MonitorCondition;
  status: MonitorStatus;
  createdAt: number;
  /** 最近一次成功结果（数值）与时间；首次运行前为空。 */
  lastValue?: number;
  lastRunAt?: number;
  /** 最近一次错误（截断），成功后清空。 */
  lastError?: string;
  consecutiveFailures: number;
  /** 最近一次发送通知的时间（冷却期判断）。 */
  lastNotifiedAt?: number;
  /**
   * 创建时的连接指纹（引擎 / 主机 / 端口 / 库 / 用户，不含凭据）。
   * 连接被删除或这些字段改变时任务自动暂停，避免对另一个库继续查询。
   */
  connFingerprint?: string;
  /** 自动暂停的原因（失败过多 / 连接变更），用户继续后清空。 */
  pausedReason?: 'failures' | 'connectionChanged' | 'startup' | 'user';
}

/** 历史数据点（jsonl 一行）。 */
export interface MonitorPoint {
  at: number;
  value?: number;
  durationMs: number;
  /** 失败时的错误码 / 简述，成功时缺省。 */
  error?: string;
  /** 跳过（上一次未结束）。 */
  skipped?: true;
}

export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 24 * 3_600_000;
export const DEFAULT_INTERVAL_MS = 5 * 60_000;
/** 估算行数超过该值时提示 COUNT(*) 成本，默认间隔放宽。 */
export const LARGE_TABLE_ROWS = 1_000_000;
export const LARGE_TABLE_INTERVAL_MS = 30 * 60_000;
export const MAX_TASKS_PER_CONNECTION = 5;
export const DEFAULT_MAX_TASKS = 20;
export const MAX_HISTORY_POINTS = 500;
export const FAILURES_BEFORE_PAUSE = 3;
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
export const MAX_ERROR_CHARS = 300;

export const SUPPORTED_ENGINES = new Set(['MYSQL', 'PG', 'SQLITE']);

export function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

/** 大表默认间隔：估算行数未知（SQLite）按普通表处理。 */
export function defaultIntervalFor(estimatedRows: number | undefined): number {
  return estimatedRows !== undefined && estimatedRows > LARGE_TABLE_ROWS ? LARGE_TABLE_INTERVAL_MS : DEFAULT_INTERVAL_MS;
}

/** 估算行数解析（树节点 `table_rows` 是字符串；PG 的 reltuples 可能为 -1）。 */
export function parseEstimatedRows(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export type CreateRejectReason = 'unsupportedEngine' | 'production' | 'connectionLimit' | 'totalLimit' | 'duplicate';

/** 创建前的通用校验（不访问数据库）。 */
export function checkCanCreate(
  input: { dbType: string; production: boolean; connId: string; database?: string; schema?: string; table: string; kind: MonitorKind },
  existing: readonly MonitorTask[],
  options: { allowProduction: boolean; maxTasks: number },
): CreateRejectReason | undefined {
  if (!SUPPORTED_ENGINES.has(input.dbType.toUpperCase())) return 'unsupportedEngine';
  if (input.production && !options.allowProduction) return 'production';
  if (existing.some((t) => t.kind === input.kind && t.connId === input.connId && (t.database ?? '') === (input.database ?? '')
    && (t.schema ?? '') === (input.schema ?? '') && t.table === input.table)) return 'duplicate';
  if (existing.filter((t) => t.connId === input.connId).length >= MAX_TASKS_PER_CONNECTION) return 'connectionLimit';
  if (existing.length >= Math.max(1, options.maxTasks)) return 'totalLimit';
  return undefined;
}

/**
 * 是否命中提醒条件。变化类需要上一次的值；没有基线（首次运行）时不提醒。
 */
export function evaluateCondition(condition: MonitorCondition, previous: number | undefined, current: number): boolean {
  switch (condition.type) {
    case 'above':
      return current > condition.value;
    case 'below':
      return current < condition.value;
    default:
      break;
  }
  if (previous === undefined) return false;
  const delta = current - previous;
  switch (condition.type) {
    case 'anyChange':
      return delta !== 0;
    case 'increaseBy':
      return delta >= condition.value;
    case 'decreaseBy':
      return -delta >= condition.value;
    case 'changePercent':
      if (previous === 0) return delta !== 0;
      return (Math.abs(delta) / Math.abs(previous)) * 100 >= condition.value;
  }
}

/** 冷却期内不重复通知。 */
export function canNotify(lastNotifiedAt: number | undefined, now: number, cooldownMs: number): boolean {
  return lastNotifiedAt === undefined || now - lastNotifiedAt >= Math.max(0, cooldownMs);
}

/** 首次触发的抖动（0–10%），避免多个任务同一刻打到数据库。 */
export function jitterDelay(intervalMs: number, random: () => number = Math.random): number {
  return Math.round(intervalMs * 0.1 * Math.min(1, Math.max(0, random())));
}

export function truncateError(message: string): string {
  const single = message.replace(/\s+/g, ' ').trim();
  return single.length > MAX_ERROR_CHARS ? `${single.slice(0, MAX_ERROR_CHARS - 1)}…` : single;
}

/** 一次成功执行后的任务状态（纯函数：返回新对象 + 是否需要通知）。 */
export function applySuccess(
  task: MonitorTask,
  value: number,
  now: number,
  cooldownMs: number,
): { task: MonitorTask; notify: boolean; previous: number | undefined } {
  const previous = task.lastValue;
  const hit = evaluateCondition(task.condition, previous, value);
  const notify = hit && canNotify(task.lastNotifiedAt, now, cooldownMs);
  const next: MonitorTask = {
    ...task,
    lastValue: value,
    lastRunAt: now,
    consecutiveFailures: 0,
    status: task.status === 'error' ? 'running' : task.status,
    ...(notify ? { lastNotifiedAt: now } : {}),
  };
  delete next.lastError;
  return { task: next, notify, previous };
}

/** 一次失败后的任务状态：连续失败达到上限即自动暂停。 */
export function applyFailure(task: MonitorTask, message: string, now: number): { task: MonitorTask; paused: boolean } {
  const failures = task.consecutiveFailures + 1;
  const paused = failures >= FAILURES_BEFORE_PAUSE;
  return {
    task: {
      ...task,
      lastRunAt: now,
      lastError: truncateError(message),
      consecutiveFailures: failures,
      status: paused ? 'paused' : 'error',
      ...(paused ? { pausedReason: 'failures' as const } : {}),
    },
    paused,
  };
}

/** 启动时所有任务置为暂停：用户不在场时不自动查询数据库。 */
export function pauseAllOnStartup(tasks: readonly MonitorTask[]): MonitorTask[] {
  return tasks.map((t) => (t.status === 'paused' ? t : { ...t, status: 'paused', pausedReason: 'startup' }));
}

export function formatInterval(ms: number, zh: boolean): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return zh ? `${minutes} 分钟` : `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return zh ? `${hours} 小时` : `${hours} h`;
}

/**
 * 连接指纹：引擎 / 主机 / 端口 / 用户 / 库（连接串模式下去掉口令后的 URL）。
 * 只用于判断「任务还是不是在查同一个库」，不含凭据，不可逆。
 */
export function connectionFingerprint(
  conn: { dbType: string; host?: string; port?: number; user?: string; useConnectionString?: boolean; connectionUrl?: string },
  database: string | undefined,
  hash: (text: string) => string,
): string {
  let url = '';
  if (conn.useConnectionString && conn.connectionUrl) {
    try {
      const parsed = new URL(conn.connectionUrl);
      parsed.password = '';
      url = parsed.toString();
    } catch {
      url = 'invalid-url';
    }
  }
  return hash(JSON.stringify([String(conn.dbType).toUpperCase(), conn.host ?? '', conn.port ?? 0, conn.user ?? '', url, database ?? '']));
}

/**
 * 树节点描述里的估算行数（`metadataNodeBuilder` 写成 `"<n> rows"`）。
 * 有注释没有行数时返回 undefined，按普通表处理。
 */
export function estimatedRowsFromDescription(description: unknown): number | undefined {
  if (typeof description !== 'string') return undefined;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s+rows\s*$/.exec(description);
  return m ? parseEstimatedRows(m[1]) : undefined;
}
