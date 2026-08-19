import type { MysqlDb } from './db.js';
import type { IAdminAuditRepo, AdminAuditInput } from '../interfaces.js';
import type { AdminAuditLog } from '../../domain/entities.js';

/**
 * 管理操作留痕仓储。
 *
 * `detail` 存 JSON 文本而不是 MySQL 的 JSON 列类型：这张表只被顺序读取和
 * 按时间过滤，从不按 detail 内部字段查询，用 JSON 列换不到任何检索能力，
 * 却会带来 5.7/8.0 之间的行为差异和更高的写入开销。
 *
 * `actor_user_id` 刻意不设外键：用户被删之后留痕必须还在 —— 「谁把这个账号
 * 删了」正是最需要追溯的一类操作，而 ON DELETE CASCADE 会把证据一起删掉。
 */
export class MysqlAdminAuditRepo implements IAdminAuditRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async record(entry: AdminAuditInput): Promise<void> {
    await this.db().query(
      `INSERT INTO admin_audit_log
         (actor_user_id, actor_email, action, target_type, target_id, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.actorUserId,
        entry.actorEmail ?? null,
        entry.action,
        entry.targetType,
        entry.targetId,
        JSON.stringify(entry.detail ?? {}),
        entry.ip ?? null,
      ],
    );
  }

  async list(limit: number, offset: number): Promise<AdminAuditLog[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(mapRow);
  }

  async count(): Promise<number> {
    const [rows] = await this.db().query<any[]>('SELECT COUNT(*) AS cnt FROM admin_audit_log');
    return Number(rows[0]?.cnt ?? 0);
  }
}

function mapRow(r: any): AdminAuditLog {
  return {
    id: r.id,
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_email ?? undefined,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    detail: parseDetail(r.detail),
    ip: r.ip ?? undefined,
    createTime: r.create_time,
  };
}

/**
 * detail 解析失败不能让整个列表接口 500。
 *
 * 一条写坏的留痕（历史数据、手工插入、字段被截断）会让 `JSON.parse` 抛错，
 * 而这张表的用途正是"出事之后拿来看"—— 那时候最不需要的就是列表打不开。
 * 坏行降级成一个带原始文本的对象，其余行照常显示。
 */
function parseDetail(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  // mysql2 对 JSON 列会直接返回对象；这里是 TEXT 列，正常是字符串
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { unparsed: String(raw) };
  }
}
