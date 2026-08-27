import type { IOrderRepo, OrderInput } from '../interfaces.js';
import type { Order } from '../../domain/entities.js';
import type { OrderStatus } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

/**
 * 订单仓储（不可变计费流水）（已接入运行时）。
 *
 * 列名与 001_initial_schema.ts 的 orders 表逐列对齐。
 * 订单一旦写入不改 status 之外的列（不可变计账）。
 */
export class MysqlOrderRepo implements IOrderRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findById(id: number): Promise<Order | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM orders WHERE id = ?', [id]);
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }

  async create(input: OrderInput): Promise<Order> {
    const [result] = await this.db().query<any>(
      `INSERT INTO orders
         (organization_id, subscription_id, plan_id, amount, currency, status,
          provider, external_id, seat_delta, period_months)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.organizationId,
        input.subscriptionId ?? null,
        input.planId,
        input.amount,
        input.currency,
        input.status,
        input.provider,
        input.externalId ?? null,
        input.seatDelta,
        input.periodMonths,
      ],
    );
    const created = await this.findById(result.insertId);
    if (!created) throw new Error('order insert failed');
    return created;
  }

  async listByOrganization(organizationId: number, limit: number, offset: number): Promise<Order[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM orders WHERE organization_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      [organizationId, limit, offset],
    );
    return rows.map(mapOrder);
  }

  async countByOrganization(organizationId: number): Promise<number> {
    const [rows] = await this.db().query<any[]>('SELECT COUNT(*) AS cnt FROM orders WHERE organization_id = ?', [
      organizationId,
    ]);
    return Number(rows[0]?.cnt ?? 0);
  }
}

function mapOrder(r: any): Order {
  return {
    id: r.id,
    organizationId: r.organization_id,
    subscriptionId: r.subscription_id ?? undefined,
    planId: r.plan_id,
    amount: Number(r.amount),
    currency: r.currency,
    status: r.status as OrderStatus,
    provider: r.provider,
    externalId: r.external_id ?? undefined,
    seatDelta: r.seat_delta,
    periodMonths: r.period_months,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
