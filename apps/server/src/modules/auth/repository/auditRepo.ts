import type { IAuditRepo, AuditFilter } from '../../../repository/interfaces.js';
import type { AuditEvent } from '../../../domain/entities.js';
import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';
import { safeLimit } from '../../../repository/sqlLimit.js';

/** 审计事件仓储：append-only，只 INSERT + SELECT，不提供 UPDATE/DELETE。 */
export class MysqlAuditRepo implements IAuditRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async insert(event: Omit<AuditEvent, 'id' | 'createTime'>): Promise<AuditEvent> {
    const [result] = await this.db().query<any>(INSERT_SQL, toParams(event));
    return { ...event, id: result.insertId, createTime: new Date() };
  }

  async insertInTx(exec: Queryable, event: Omit<AuditEvent, 'id' | 'createTime'>): Promise<AuditEvent> {
    const [result] = await exec.query<any>(INSERT_SQL, toParams(event));
    return { ...event, id: result.insertId, createTime: new Date() };
  }

  async search(input: AuditFilter): Promise<AuditEvent[]> {
    const { sql, params } = buildFilter(input, false);
    const [rows] = await this.db().query<any[]>(sql, params);
    return rows.map(mapAudit);
  }

  async count(input: Omit<AuditFilter, 'cursor' | 'limit'>): Promise<number> {
    const { sql, params } = buildFilter(input, true);
    const [rows] = await this.db().query<any[]>(sql, params);
    return Number(rows[0]?.cnt ?? 0);
  }

  async searchInTx(exec: Queryable, input: AuditFilter): Promise<AuditEvent[]> {
    const { sql, params } = buildFilter(input, false);
    const [rows] = await exec.query<any[]>(sql, params);
    return rows.map(mapAudit);
  }

  async countInTx(exec: Queryable, input: Omit<AuditFilter, 'cursor' | 'limit'>): Promise<number> {
    const { sql, params } = buildFilter(input, true);
    const [rows] = await exec.query<any[]>(sql, params);
    return Number(rows[0]?.cnt ?? 0);
  }
}

const INSERT_SQL = `INSERT INTO audit_events
  (event_time, actor_user_id, actor_role, event_type, target_type, target_id,
   source_ip, request_id, result, failure_code, reason)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function toParams(event: Omit<AuditEvent, 'id' | 'createTime'>): unknown[] {
  return [
    event.eventTime,
    event.actorUserId,
    event.actorRole,
    event.eventType,
    event.targetType,
    event.targetId,
    event.sourceIp,
    event.requestId,
    event.result,
    event.failureCode,
    event.reason,
  ];
}

function buildFilter(input: Omit<AuditFilter, 'cursor' | 'limit'> & { cursor?: number; limit?: number }, countOnly: boolean): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (input.fromTime) {
    where.push('event_time >= ?');
    params.push(input.fromTime);
  }
  if (input.toTime) {
    where.push('event_time <= ?');
    params.push(input.toTime);
  }
  if (input.actorUserId !== undefined) {
    where.push('actor_user_id = ?');
    params.push(input.actorUserId);
  }
  if (input.eventType) {
    where.push('event_type = ?');
    params.push(input.eventType);
  }
  if (input.targetType) {
    where.push('target_type = ?');
    params.push(input.targetType);
  }
  if (input.targetId !== undefined) {
    where.push('target_id = ?');
    params.push(input.targetId);
  }
  if (input.result) {
    where.push('result = ?');
    params.push(input.result);
  }
  if (input.cursor !== undefined) {
    where.push('id < ?');
    params.push(input.cursor);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  if (countOnly) {
    return { sql: `SELECT COUNT(*) AS cnt FROM audit_events ${whereSql}`, params };
  }

  const sql = `SELECT * FROM audit_events ${whereSql} ORDER BY id DESC LIMIT ${safeLimit(input.limit)}`;
  return { sql, params };
}

function mapAudit(r: any): AuditEvent {
  return {
    id: r.id,
    eventTime: new Date(r.event_time),
    actorUserId: r.actor_user_id ?? null,
    actorRole: r.actor_role ?? null,
    eventType: r.event_type,
    targetType: r.target_type ?? null,
    targetId: r.target_id ?? null,
    sourceIp: r.source_ip ?? null,
    requestId: r.request_id ?? null,
    result: r.result,
    failureCode: r.failure_code ?? null,
    reason: r.reason ?? null,
    // audit_events 现只有单一时间列 event_time（create_time 已随 baseline 移除）。
    createTime: new Date(r.event_time),
  };
}