import type { IConnectionMetaRepo, ConnectionMetaInput } from '../interfaces.js';
import type { ConnectionMeta } from '../../domain/entities.js';
import type { MysqlDb } from './db.js';

/**
 * 连接元数据仓储：connection_meta 表（明文元数据，服务端计量/分析用）。
 * 连接内容仍端到端加密存于 sync_sections，此处仅存非敏感元数据。
 */
export class MysqlConnectionMetaRepo implements IConnectionMetaRepo {
  constructor(private readonly db: () => MysqlDb) {}

  /**
   * 全量替换某用户的连接元数据。
   *
   * 「全量」二字此前不成立：实现只做 upsert，**从不处理入参里缺失的行**。
   * 于是客户端删掉一个连接后，服务端那行仍是 `deleted = 0` —— 库内活跃数只增
   * 不减。配合「校验入参条数」的旧逻辑，每次只上报 1 条新 meta 就能把
   * maxConnections 配额突破到任意大。
   *
   * 缺失的行置为墓碑而非物理删除：`connection_meta` 是计量/分析用的明文元数据，
   * 保留墓碑才能区分「从未上报过」与「曾经存在后被删除」。
   *
   * 返回值取自**库内真值**（countActive）而不是入参推算 —— 原实现返回的是
   * `metas.filter(m => !m.deleted).length`，与 countActive 读的是两回事，
   * 两者可以不一致，而 /api/me 报的用量与配额校验用的数就此对不上。
   */
  async replaceAll(userId: number, metas: ConnectionMetaInput[]): Promise<number> {
    if (metas.length === 0) {
      // 全清空：所有现存行置墓碑
      await this.db().query(
        'UPDATE connection_meta SET deleted = 1 WHERE user_id = ? AND deleted = 0',
        [userId],
      );
      return 0;
    }

    // 分片：500 连接 x 9 参数 = 4500 个占位符，默认 max_allowed_packet 下安全，
    // 但显式分片避免将来配额调大时撞上包大小或占位符上限
    const CHUNK = 200;
    for (let i = 0; i < metas.length; i += CHUNK) {
      const slice = metas.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params: any[] = [];
      for (const m of slice) {
        params.push(
          userId, m.connUuid, m.type, m.name ?? null, m.groupName ?? null,
          m.enabled ? 1 : 0, m.deleted ? 1 : 0, m.createdAt ?? null, m.updatedAt ?? null,
        );
      }
      await this.db().query(
        `INSERT INTO connection_meta (user_id, conn_uuid, type, name, group_name, enabled, deleted, created_at, updated_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           type = VALUES(type), name = VALUES(name), group_name = VALUES(group_name),
           enabled = VALUES(enabled), deleted = VALUES(deleted),
           created_at = VALUES(created_at), updated_at = VALUES(updated_at)`,
        params,
      );
    }

    // 本次未上报的行 = 客户端已删除 → 置墓碑。这是「全量替换」的另一半。
    const uuids = metas.map((m) => m.connUuid);
    await this.db().query(
      `UPDATE connection_meta SET deleted = 1
        WHERE user_id = ? AND deleted = 0 AND conn_uuid NOT IN (${uuids.map(() => '?').join(', ')})`,
      [userId, ...uuids],
    );

    return this.countActive(userId);
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