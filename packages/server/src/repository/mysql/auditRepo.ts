import type { IAuditRepo } from '../interfaces.js';
import type { AuditEvent } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

/** 审计事件仓储：append-only，只 INSERT，不提供 UPDATE/DELETE。 */
export class MysqlAuditRepo implements IAuditRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async insert(event: Omit<AuditEvent, 'id' | 'createTime'>): Promise<AuditEvent> {
    const [result] = await this.db().query<any>(
      `INSERT INTO audit_events
        (event_time, actor_user_id, actor_role, event_type, target_type, target_id, organization_id,
         source_ip, request_id, result, failure_code, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.eventTime,
        event.actorUserId,
        event.actorRole,
        event.eventType,
        event.targetType,
        event.targetId,
        event.organizationId,
        event.sourceIp,
        event.requestId,
        event.result,
        event.failureCode,
        event.reason,
      ],
    );
    return { ...event, id: result.insertId, createTime: new Date() };
  }
}