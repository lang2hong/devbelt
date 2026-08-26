import type { ISeatRepo, SeatInput } from '../interfaces.js';
import type { Seat } from '../../domain/entities.js';
import type { SeatStatus } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

/**
 * 席位仓储（逐席数量；增减由订单 seat_delta 驱动）（已接入运行时）。
 *
 * 列名与 001_initial_schema.ts 的 seats 表逐列对齐。
 * 约束（应用层）：活跃 membership 数 ≤ 活跃 seats 数，靠 countActiveByOrganization 与
 * IMembershipRepo.countActiveByOrganization 配对校验，不靠数据库约束。
 */
export class MysqlSeatRepo implements ISeatRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<Seat | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM seats WHERE id = ? AND delete_time IS NULL', [id]);
    return rows[0] ? mapSeat(rows[0]) : undefined;
  }

  async listByOrganization(organizationId: number): Promise<Seat[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM seats WHERE organization_id = ? AND delete_time IS NULL ORDER BY id',
      [organizationId],
    );
    return rows.map(mapSeat);
  }

  async countActiveByOrganization(organizationId: number): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      `SELECT COUNT(*) AS cnt FROM seats
       WHERE organization_id = ? AND status = 'active' AND delete_time IS NULL`,
      [organizationId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  async create(input: SeatInput): Promise<Seat> {
    const [result] = await this.db().query<any>(
      'INSERT INTO seats (subscription_id, organization_id, status) VALUES (?, ?, ?)',
      [input.subscriptionId, input.organizationId, 'active'],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('seat insert failed');
    return created;
  }

  async revoke(id: number): Promise<void> {
    await this.db().query(`UPDATE seats SET status = 'revoked' WHERE id = ?`, [id]);
  }
}

function mapSeat(r: any): Seat {
  return {
    id: r.id,
    subscriptionId: r.subscription_id,
    organizationId: r.organization_id,
    status: r.status as SeatStatus,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
    deleteTime: r.delete_time ? new Date(r.delete_time) : undefined,
  };
}
