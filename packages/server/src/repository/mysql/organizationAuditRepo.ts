import type { IOrganizationAuditRepo, OrganizationAuditInput } from '../interfaces.js';
import type { OrganizationAuditLog } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

/**
 * 组织协作审计仓储（已接入运行时）。
 *
 * 与 MysqlAdminAuditRepo 同构：detail 存 JSON 文本（不是 MySQL JSON 列类型）——
 * 这张表只被顺序读取和按时间过滤，从不按 detail 内部字段查询，用 JSON 列换不到
 * 检索能力却带来 5.7/8.0 行为差异与更高写入开销。actor_user_id / organization_id
 * 刻意不设外键：组织或成员删除后留痕必须保留，CASCADE 会把证据删掉。
 */
export class MysqlOrganizationAuditRepo implements IOrganizationAuditRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async record(entry: OrganizationAuditInput): Promise<void> {
    await this.db().query(
      `INSERT INTO organization_audit_log
         (organization_id, actor_user_id, action, resource_type, resource_id, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.organizationId,
        entry.actorUserId ?? null,
        entry.action,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.detail != null ? JSON.stringify(entry.detail) : null,
        entry.ip ?? null,
      ],
    );
  }

  async listByOrganization(organizationId: number, limit: number, offset: number): Promise<OrganizationAuditLog[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM organization_audit_log WHERE organization_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      [organizationId, limit, offset],
    );
    return rows.map(mapRow);
  }

  async countByOrganization(organizationId: number): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      'SELECT COUNT(*) AS cnt FROM organization_audit_log WHERE organization_id = ?',
      [organizationId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }
}

function mapRow(r: any): OrganizationAuditLog {
  return {
    id: r.id,
    organizationId: r.organization_id,
    actorUserId: r.actor_user_id ?? undefined,
    action: r.action,
    resourceType: r.resource_type ?? undefined,
    resourceId: r.resource_id ?? undefined,
    detail: parseDetail(r.detail),
    ip: r.ip ?? undefined,
    createTime: new Date(r.create_time),
  };
}

/**
 * detail 解析失败不能让列表接口 500：一条写坏的留痕（历史数据 / 手工插入 /
 * 字段被截断）会让 JSON.parse 抛错，而这表的用途正是「出事之后拿来看」，
 * 那时最不需要的就是列表打不开。坏行降级成带原始文本的对象，其余行照常显示。
 */
function parseDetail(raw: unknown): Record<string, unknown> | undefined {
  if (raw == null) return undefined;
  // mysql2 对 JSON 列会直接返回对象；这里是 TEXT 列，正常是字符串
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { unparsed: String(raw) };
  }
}
