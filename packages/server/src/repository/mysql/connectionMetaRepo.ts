import type { IConnectionMetaRepo, ConnectionMetaInput } from '../interfaces.js';
import type { ConnectionMeta } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

/**
 * 连接元数据仓储：connection_meta 表（明文元数据，服务端计量/分析用）。
 * 连接内容仍端到端加密存于 sync_sections，此处仅存非敏感元数据。
 */
export class MysqlConnectionMetaRepo implements IConnectionMetaRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async replaceAll(userId: number, metas: ConnectionMetaInput[]): Promise<number> {
    const active = metas.filter((m) => !m.deleted).length;
    for (const m of metas) {
      await this.db().query(
        `INSERT INTO connection_meta (user_id, conn_uuid, type, name, group_name, enabled, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           type = VALUES(type), name = VALUES(name), group_name = VALUES(group_name),
           enabled = VALUES(enabled), deleted = VALUES(deleted),
           created_at = VALUES(created_at), updated_at = VALUES(updated_at)`,
        [
          userId, m.connUuid, m.type, m.name ?? null, m.groupName ?? null,
          m.enabled ? 1 : 0, m.deleted ? 1 : 0, m.createdAt ?? null, m.updatedAt ?? null,
        ],
      );
    }
    return active;
  }

  async countActive(userId: number): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      'SELECT COUNT(*) AS cnt FROM connection_meta WHERE user_id = ? AND deleted = 0',
      [userId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async listByUser(userId: number): Promise<ConnectionMeta[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM connection_meta WHERE user_id = ? ORDER BY id DESC',
      [userId],
    );
    return rows.map(mapMeta);
  }
}

function mapMeta(r: any): ConnectionMeta {
  return {
    id: r.id,
    userId: r.user_id,
    connUuid: r.conn_uuid,
    type: r.type,
    name: r.name ?? undefined,
    groupName: r.group_name ?? undefined,
    enabled: !!r.enabled,
    deleted: !!r.deleted,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}