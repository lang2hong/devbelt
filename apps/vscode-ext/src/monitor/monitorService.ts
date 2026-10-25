import { randomBytes } from 'node:crypto';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { ColumnMeta, IndexMeta } from '@devbelt/db-core';
import { checkMetricResult, checkMetricSql, checkCursorColumn, type ValidationIssue } from './monitorValidate';
import { readCursorBaseline, type MonitorExecutor } from './monitorExecutor';
import type { MonitorScheduler } from './monitorScheduler';
import {
  checkCanCreate,
  clampInterval,
  DEFAULT_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  type CreateRejectReason,
  type MonitorCondition,
  type MonitorKind,
  type MonitorTask,
} from './monitorTypes';

/**
 * 监控提案（Agent `propose_monitor` 产出、用户在对话卡片上确认）。
 *
 * 提案只是校验过的描述，不是任务；`create` 时**重新校验一遍**再落任务，
 * 防止提案生成后表结构 / 连接 / 设置变化，或 webview 回传被篡改。
 */
export interface MonitorProposal {
  id: string;
  kind: MonitorKind;
  connId: string;
  connName: string;
  database?: string;
  schema?: string;
  table: string;
  label?: string;
  intervalMs: number;
  condition: MonitorCondition;
  /** A2 */
  sql?: string;
  columns?: string[];
  watchColumn?: string;
  /** 试执行得到的当前值（A2 各列 / B 无）。 */
  preview?: Record<string, number | null>;
  /** B */
  cursorColumn?: string;
  cursorKind?: 'integer' | 'temporal';
  primaryKey?: string[];
  /** 校验提示（warning 级别；error 级别不会生成可确认的提案）。 */
  warnings: ValidationIssue[];
}

export interface ProposalInput {
  kind: MonitorKind;
  table: string;
  label?: string;
  intervalMinutes?: number;
  condition?: MonitorCondition;
  sql?: string;
  watchColumn?: string;
  cursorColumn?: string;
}

export type ProposalResult =
  | { ok: true; proposal: MonitorProposal }
  | { ok: false; reason: CreateRejectReason | 'validation' | 'disabled' | 'unsupportedKind' | 'otherWindow'; issues: ValidationIssue[]; detail?: string };

export interface MonitorServiceDeps {
  scheduler: MonitorScheduler;
  executor: MonitorExecutor;
  getConnection(id: string): SavedConnection | undefined;
  fingerprint(conn: SavedConnection, database: string | undefined): string;
  allowProduction(): boolean;
  maxTasks(): number;
  enabled(): boolean;
  /** 读列 / 索引元数据（B 校验）；走独立只读会话，不调用模型。 */
  describe(conn: SavedConnection, database: string | undefined, schema: string | undefined, table: string): Promise<{ columns: ColumnMeta[]; indexes: IndexMeta[] }>;
  audit(action: 'create' | 'remove' | 'pause' | 'resume', task: MonitorTask): void;
  /** 本窗口是否拥有任务（持锁）；缺省视为拥有。非拥有者不试执行、不创建。 */
  isOwner?(): boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_CONDITIONS = new Set(['anyChange', 'increaseBy', 'decreaseBy', 'changePercent', 'above', 'below']);

/** 模型给的条件做白名单 + 数值检查；非法时回退默认（新增行：≥1；其他：任意变化）。 */
export function sanitizeCondition(raw: unknown, kind: MonitorKind): MonitorCondition {
  const fallback: MonitorCondition = kind === 'newRows' ? { type: 'increaseBy', value: 1 } : { type: 'anyChange' };
  if (!raw || typeof raw !== 'object') return fallback;
  const c = raw as { type?: unknown; value?: unknown };
  if (typeof c.type !== 'string' || !VALID_CONDITIONS.has(c.type)) return fallback;
  if (c.type === 'anyChange') return { type: 'anyChange' };
  const value = Number(c.value);
  if (!Number.isFinite(value)) return fallback;
  if (kind === 'newRows' && c.type !== 'increaseBy' && c.type !== 'above') return fallback;
  if ((c.type === 'increaseBy' || c.type === 'decreaseBy' || c.type === 'changePercent') && value <= 0) return fallback;
  return { type: c.type, value } as MonitorCondition;
}

function intervalFrom(minutes: unknown): number {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return clampInterval(Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, n * 60_000)));
}

export class MonitorService {
  /** 试执行超过这个耗时时在卡片上提示成本，并建议放宽间隔。 */
  static readonly SLOW_TRIAL_MS = 5_000;

  /** 待确认的提案（内存；面板关闭或 30 分钟后失效）。 */
  private readonly proposals = new Map<string, { proposal: MonitorProposal; at: number }>();

  constructor(private readonly deps: MonitorServiceDeps) {}

  /**
   * 校验并生成提案（不创建任务）。A2 会在只读会话上试执行一次；B 会读列与索引。
   * 目标连接 / 库 / schema 由调用方固定（Agent 会话的绑定），模型不能指定。
   */
  async propose(conn: SavedConnection, database: string | undefined, schema: string | undefined, input: ProposalInput): Promise<ProposalResult> {
    if (!this.deps.enabled()) return { ok: false, reason: 'disabled', issues: [] };
    if (this.deps.isOwner && !this.deps.isOwner()) return { ok: false, reason: 'otherWindow', issues: [] };
    if (input.kind !== 'rowCount' && input.kind !== 'metric' && input.kind !== 'newRows') {
      return { ok: false, reason: 'unsupportedKind', issues: [] };
    }
    const dbType = String(conn.dbType);
    const reject = checkCanCreate(
      {
        dbType,
        production: conn.environment === 'production',
        connId: conn.id,
        ...(database ? { database } : {}),
        ...(schema ? { schema } : {}),
        table: input.table,
        kind: input.kind,
        ...(input.sql ? { sql: input.sql } : {}),
      },
      this.deps.scheduler.list(),
      { allowProduction: this.deps.allowProduction(), maxTasks: this.deps.maxTasks() },
    );
    if (reject) return { ok: false, reason: reject, issues: [] };

    const base = {
      id: `p${Date.now().toString(36)}${randomBytes(4).toString('hex')}`,
      kind: input.kind,
      connId: conn.id,
      connName: conn.name || conn.host,
      ...(database ? { database } : {}),
      ...(schema ? { schema } : {}),
      table: input.table,
      ...(input.label ? { label: input.label.slice(0, 80) } : {}),
      intervalMs: intervalFrom(input.intervalMinutes),
      condition: sanitizeCondition(input.condition, input.kind),
    };

    if (input.kind === 'metric') {
      const check = checkMetricSql(input.sql ?? '', engineOf(dbType));
      if (!check.ok) return { ok: false, reason: 'validation', issues: [check.issue] };
      let rows: unknown[] | undefined;
      // 只计查询本身：建会话（SSH 隧道、设只读）的耗时不算进「查询较重」。
      let elapsed = 0;
      try {
        rows = await this.deps.executor.trial({ connId: conn.id, database, schema }, async (session, token) => {
          const startedAt = Date.now();
          try {
            return (await session.query.query(check.statement, undefined, { skipHistory: true, token }))?.rows;
          } finally {
            elapsed = Date.now() - startedAt;
          }
        });
      } catch (err) {
        return { ok: false, reason: 'validation', issues: [{ level: 'error', code: 'trialFailed', detail: messageOf(err) }] };
      }
      const shape = checkMetricResult(rows, input.watchColumn);
      if (!shape.ok) return { ok: false, reason: 'validation', issues: shape.issues };
      // 慢查询只提示、不拦截，也不改用户 / 模型给的间隔（卡片上的提示建议不低于 15 分钟）。
      const slow = elapsed >= MonitorService.SLOW_TRIAL_MS;
      return this.remember({
        ...base,
        sql: check.statement,
        columns: shape.columns!,
        watchColumn: shape.watchColumn!,
        preview: shape.values!,
        warnings: slow ? [{ level: 'warning', code: 'slowQuery', detail: String(Math.round(elapsed / 100) / 10) }] : [],
      });
    }

    if (input.kind === 'newRows') {
      let meta: { columns: ColumnMeta[]; indexes: IndexMeta[] };
      try {
        meta = await this.deps.describe(conn, database, schema, input.table);
      } catch (err) {
        return { ok: false, reason: 'validation', issues: [{ level: 'error', code: 'tableMissing', detail: messageOf(err) }] };
      }
      const cursor = checkCursorColumn({
        dbType,
        table: input.table,
        ...(schema ? { schema } : {}),
        column: input.cursorColumn ?? '',
        columns: meta.columns,
        indexes: meta.indexes,
      });
      if (!cursor.ok) return { ok: false, reason: 'validation', issues: cursor.issues };
      const actual = meta.columns.find((c) => c.name.toLowerCase() === (input.cursorColumn ?? '').toLowerCase())!.name;
      return this.remember({
        ...base,
        cursorColumn: actual,
        cursorKind: cursor.cursorKind!,
        primaryKey: cursor.primaryKey,
        warnings: cursor.issues.filter((i) => i.level === 'warning'),
      });
    }

    return this.remember({ ...base, warnings: [] });
  }

  getProposal(id: string): MonitorProposal | undefined {
    this.expire();
    return this.proposals.get(id)?.proposal;
  }

  /**
   * 用户在卡片上确认：只接受由本服务生成且仍有效的提案 id；只允许修改间隔与条件。
   * 重新跑一遍 propose 的校验，再取基线并创建任务。
   */
  async confirm(proposalId: string, overrides: { intervalMinutes?: number; condition?: MonitorCondition } = {}): Promise<{ ok: true; task: MonitorTask } | { ok: false; reason: string; issues: ValidationIssue[] }> {
    if (!ID_RE.test(proposalId)) return { ok: false, reason: 'unknownProposal', issues: [] };
    const stored = this.getProposal(proposalId);
    if (!stored) return { ok: false, reason: 'unknownProposal', issues: [] };
    const conn = this.deps.getConnection(stored.connId);
    if (!conn) return { ok: false, reason: 'connectionMissing', issues: [] };
    const again = await this.propose(conn, stored.database, stored.schema, {
      kind: stored.kind,
      table: stored.table,
      ...(stored.label ? { label: stored.label } : {}),
      intervalMinutes: (overrides.intervalMinutes ?? stored.intervalMs / 60_000),
      condition: overrides.condition ?? stored.condition,
      ...(stored.sql ? { sql: stored.sql } : {}),
      ...(stored.watchColumn ? { watchColumn: stored.watchColumn } : {}),
      ...(stored.cursorColumn ? { cursorColumn: stored.cursorColumn } : {}),
    });
    // 二次校验产生的临时提案不保留。
    if (again.ok) this.proposals.delete(again.proposal.id);
    if (!again.ok) return { ok: false, reason: again.reason, issues: again.issues };
    const p = again.proposal;
    let cursor: { value: string; seen: string[] } | undefined;
    if (p.kind === 'newRows') {
      try {
        cursor = await this.deps.executor.trial({ connId: conn.id, database: p.database, schema: p.schema }, (session, token, dbType) =>
          readCursorBaseline(session, dbType, { table: p.table, ...(p.schema ? { schema: p.schema } : {}), cursorColumn: p.cursorColumn!, primaryKey: p.primaryKey ?? [] }, token));
      } catch (err) {
        return { ok: false, reason: 'validation', issues: [{ level: 'error', code: 'trialFailed', detail: messageOf(err) }] };
      }
    }
    const task: MonitorTask = {
      id: `m${Date.now().toString(36)}${randomBytes(4).toString('hex')}`,
      kind: p.kind,
      connId: p.connId,
      ...(p.database ? { database: p.database } : {}),
      ...(p.schema ? { schema: p.schema } : {}),
      table: p.table,
      ...(p.label ? { label: p.label } : {}),
      intervalMs: p.intervalMs,
      condition: p.condition,
      status: 'running',
      createdAt: Date.now(),
      consecutiveFailures: 0,
      connFingerprint: this.deps.fingerprint(conn, p.database),
      origin: 'ai',
      ...(p.sql ? { sql: p.sql, columns: p.columns, watchColumn: p.watchColumn } : {}),
      ...(p.cursorColumn ? { cursorColumn: p.cursorColumn, cursorKind: p.cursorKind, primaryKey: p.primaryKey ?? [] } : {}),
      ...(cursor ? { cursorValue: cursor.value, cursorSeen: cursor.seen } : {}),
    };
    this.proposals.delete(proposalId);
    await this.deps.scheduler.add(task);
    this.deps.audit('create', task);
    return { ok: true, task: this.deps.scheduler.get(task.id) ?? task };
  }

  discard(proposalId: string): void {
    this.proposals.delete(proposalId);
  }

  private remember(proposal: MonitorProposal): ProposalResult {
    this.expire();
    this.proposals.set(proposal.id, { proposal, at: Date.now() });
    return { ok: true, proposal };
  }

  private expire(): void {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, entry] of this.proposals) if (entry.at < cutoff) this.proposals.delete(id);
  }
}

function engineOf(dbType: string): 'MYSQL' | 'PG' | 'SQLITE' {
  const e = dbType.toUpperCase();
  if (e === 'MYSQL' || e === 'PG' || e === 'SQLITE') return e;
  throw new Error(`unsupported engine: ${dbType}`);
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
}
