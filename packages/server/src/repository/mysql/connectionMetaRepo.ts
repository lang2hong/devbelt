import type { IConnectionMetaRepo, ConnectionMetaInput } from '../interfaces.js';
import type { ConnectionMeta } from '../../domain/entities.js';
import { withTransaction, type MysqlDb } from './db.js';

/** 能执行 SQL 的东西：连接池或事务连接 */
type Exec = { query<T = any>(sql: string, params?: any[]): Promise<T> };

/**
 * 连接元数据仓储：connection_meta 表（明文元数据，服务端计量/分析用）。
 * 连接内容仍端到端加密存于 sync_sections，此处仅存非敏感元数据。
 *
 * v2：列改为 conn_id（客户端连接 UUID）、client_created_at / client_updated_at
 * （客户端 epoch 毫秒），软删除由 deleted 布尔改为 delete_time 墓碑。
 */
export class MysqlConnectionMetaRepo implements IConnectionMetaRepo {
  constructor(private readonly db: () => MysqlDb) {}

  /**
   * 全量替换某用户的连接元数据。
   *
   * 「全量」两半：上报行 upsert + 未上报行置墓碑（delete_time = NOW()）。
   * 缺失的行置墓碑而非物理删除：保留墓碑才能区分「从未上报」与「曾存在后被删」。
   * 两半必须在同一事务内，否则会留下「新连接已入库、被删连接墓碑没打」的半套数据。
   */
  async replaceAll(userId: number, metas: ConnectionMetaInput[]): Promise<number> {
    if (metas.length === 0) {
      await this.db().query(
        'UPDATE connection_meta SET delete_time = NOW() WHERE user_id = ? AND delete_time IS NULL',
        [userId],
      );
      return 0;
    }

    return withTransaction(this.db(), async (tx) => {
      // 分片：500 连接 x 8 参数 = 4000 个占位符，显式分片避免将来配额调大撞上包大小
      const CHUNK = 200;
      for (let i = 0; i < metas.length; i += CHUNK) {
        const slice = metas.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const params: any[] = [];
        for (const m of slice) {
          params.push(
            userId, m.connId, m.type, m.name ?? null, m.groupName ?? null,
            m.enabled ? 1 : 0, m.clientCreatedAt ?? null, m.clientUpdatedAt ?? null,
          );
        }
        await tx.query(
          `INSERT INTO connection_meta (user_id, conn_id, type, name, group_name, enabled, client_created_at, client_updated_at)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             type = VALUES(type), name = VALUES(name), group_name = VALUES(group_name),
             enabled = VALUES(enabled), client_created_at = VALUES(client_created_at),
             client_updated_at = VALUES(client_updated_at), delete_time = NULL`,
          params,
        );
      }

      // 本次未上报的行 = 客户端已删除 → 置墓碑。这是「全量替换」的另一半。
      const connIds = metas.map((m) => m.connId);
      await tx.query(
        `UPDATE connection_meta SET delete_time = NOW()
          WHERE user_id = ? AND delete_time IS NULL AND conn_id NOT IN (${connIds.map(() => '?').join(', ')})`,
        [userId, ...connIds],
      );

      return this.countActiveOn(tx, userId);
    });
  }

  async countActive(userId: number): Promise<number> {
    return this.countActiveOn(this.db(), userId);
  }

  private async countActiveOn(exec: Exec, userId: number): Promise<number> {
    const [rows] = await exec.query<any[]>(
      'SELECT COUNT(*) AS cnt FROM connection_meta WHERE user_id = ? AND delete_time IS NULL',
      [userId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async listByUser(userId: number): Promise<ConnectionMeta[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM connection_meta WHERE user_id = ? AND delete_time IS NULL ORDER BY id DESC',
      [userId],
    );
    return rows.map(mapMeta);
  }
}

function mapMeta(r: any): ConnectionMeta {
  return {
    id: r.id,
    userId: r.user_id,
    connId: r.conn_id,
    type: r.type,
    name: r.name ?? undefined,
    groupName: r.group_name ?? undefined,
    enabled: !!r.enabled,
    clientCreatedAt: r.client_created_at ?? undefined,
    clientUpdatedAt: r.client_updated_at ?? undefined,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
    deleteTime: r.delete_time ? new Date(r.delete_time) : undefined,
  };
}