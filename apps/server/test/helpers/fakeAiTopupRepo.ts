import type {
  AiGrantAvailability,
  AiGrantDetail,
  AiGrantRow,
  AiTopupOrder,
  AiTopupSku,
  IAiTopupRepo,
} from '../../src/modules/ai/repository/aiTopupRepo.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

/**
 * 内存版加油包仓储（测试用）：SKU/订单/grants 三表的内存镜像，保持与 SQL 版一致的
 * 不变量（order_id 唯一=入账幂等、tokens LEAST 语义、过期过滤、FIFO 升序锁）。
 * 真库语义由 integration 测试验证。
 */
export class MemoryAiTopupRepo implements IAiTopupRepo {
  readonly skus = new Map<string, AiTopupSku>();
  readonly orders = new Map<string, AiTopupOrder>();
  readonly grants = new Map<number, AiGrantRow & { userId: number; orderId: number; skuCode: string; status: string }>();
  private nextGrantId = 1;
  private nextOrderId = 1;

  seedSku(sku: Partial<AiTopupSku> & { code: string }): void {
    this.skus.set(sku.code, {
      code: sku.code,
      label: sku.label ?? { en: sku.code, zh: sku.code },
      tokens: sku.tokens ?? 1000,
      priceCents: sku.priceCents ?? 100,
      validDays: sku.validDays ?? 365,
      status: sku.status ?? 'active',
      sortOrder: sku.sortOrder ?? 0,
    });
  }

  seedGrant(input: { userId: number; tokens: number; expiresTime: Date; skuCode?: string; orderId?: number }): number {
    const id = this.nextGrantId++;
    this.grants.set(id, {
      id,
      userId: input.userId,
      orderId: input.orderId ?? id,
      skuCode: input.skuCode ?? 'seed',
      tokensTotal: input.tokens,
      tokensUsed: 0,
      tokensReserved: 0,
      expiresTime: input.expiresTime,
      status: 'active',
    });
    return id;
  }

  async listActiveSkus(): Promise<AiTopupSku[]> {
    return [...this.skus.values()]
      .filter((s) => s.status === 'active')
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  }

  async listSkusAll(): Promise<AiTopupSku[]> {
    return [...this.skus.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  }

  async findSkuByCodeInTx(_exec: Queryable, code: string): Promise<AiTopupSku | undefined> {
    return this.skus.get(code);
  }

  async updateSkuInTx(
    _exec: Queryable,
    code: string,
    patch: { priceCents?: number; status?: 'active' | 'disabled'; label?: { en: string; zh: string }; validDays?: number; sortOrder?: number },
  ): Promise<boolean> {
    const sku = this.skus.get(code);
    if (!sku) return false;
    if (patch.priceCents !== undefined) sku.priceCents = patch.priceCents;
    if (patch.status !== undefined) sku.status = patch.status;
    if (patch.label !== undefined) sku.label = patch.label;
    if (patch.validDays !== undefined) sku.validDays = patch.validDays;
    if (patch.sortOrder !== undefined) sku.sortOrder = patch.sortOrder;
    return true;
  }

  async listGrantsByUser(userId: number, limit: number): Promise<AiGrantDetail[]> {
    return [...this.grants.values()]
      .filter((g) => g.userId === userId)
      .sort((a, b) => a.expiresTime.getTime() - b.expiresTime.getTime() || a.id - b.id)
      .slice(0, Math.max(1, Math.min(limit, 200)))
      .map((g) => ({
        id: g.id,
        orderId: g.orderId,
        skuCode: g.skuCode,
        status: g.status as AiGrantDetail['status'],
        tokensTotal: g.tokensTotal,
        tokensUsed: g.tokensUsed,
        tokensReserved: g.tokensReserved,
        expiresTime: g.expiresTime,
      }));
  }

  async findSkuByCode(code: string): Promise<AiTopupSku | undefined> {
    return this.skus.get(code);
  }

  async insertTopupOrderInTx(
    _exec: Queryable,
    input: { orderNo: string; userId: number; skuCode: string; amountCents: number; channel: 'wechat' | 'alipay' | 'manual'; status: 'pending' | 'fulfilled'; expiresTime: Date },
  ): Promise<AiTopupOrder> {
    const order: AiTopupOrder = {
      id: this.nextOrderId++,
      orderNo: input.orderNo,
      userId: input.userId,
      skuCode: input.skuCode,
      amountCents: input.amountCents,
      status: input.status,
      channel: input.channel,
      expiresTime: input.expiresTime,
    };
    this.orders.set(order.orderNo, order);
    return { ...order };
  }

  async lockOrderByNoInTx(_exec: Queryable, orderNo: string): Promise<AiTopupOrder | undefined> {
    const o = this.orders.get(orderNo);
    return o ? { ...o } : undefined;
  }

  async findPendingByUserAndSku(userId: number, skuCode: string, channel: 'wechat' | 'alipay'): Promise<AiTopupOrder | undefined> {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId && o.skuCode === skuCode && o.channel === channel && o.status === 'pending' && o.expiresTime.getTime() > Date.now())
      .sort((a, b) => b.id - a.id)[0];
  }

  async setOrderStatusInTx(
    _exec: Queryable,
    orderId: number,
    from: AiTopupOrder['status'],
    to: AiTopupOrder['status'],
  ): Promise<boolean> {
    for (const o of this.orders.values()) {
      if (o.id === orderId && o.status === from) {
        o.status = to;
        return true;
      }
    }
    return false;
  }

  async insertGrantInTx(
    _exec: Queryable,
    input: { userId: number; orderId: number; skuCode: string; tokens: number; expiresTime: Date },
  ): Promise<boolean> {
    for (const g of this.grants.values()) {
      if (g.orderId === input.orderId) return false; // uq_grants_order 幂等
    }
    const id = this.nextGrantId++;
    this.grants.set(id, {
      id,
      userId: input.userId,
      orderId: input.orderId,
      skuCode: input.skuCode,
      tokensTotal: input.tokens,
      tokensUsed: 0,
      tokensReserved: 0,
      expiresTime: input.expiresTime,
      status: 'active',
    });
    return true;
  }

  async refundGrantByOrderInTx(_exec: Queryable, orderId: number): Promise<void> {
    for (const g of this.grants.values()) {
      if (g.orderId === orderId && g.status !== 'refunded') {
        g.status = 'refunded';
        g.tokensReserved = 0;
      }
    }
  }

  async expireStaleInTx(_exec: Queryable, userId: number, now: Date): Promise<void> {
    for (const g of this.grants.values()) {
      if (g.userId === userId && g.status === 'active' && g.expiresTime.getTime() <= now.getTime()) {
        g.status = 'expired';
      }
    }
  }

  async lockActiveInTx(_exec: Queryable, userId: number, now: Date): Promise<AiGrantRow[]> {
    return [...this.grants.values()]
      .filter((g) => g.userId === userId && g.status === 'active' && g.expiresTime.getTime() > now.getTime())
      .sort((a, b) => a.expiresTime.getTime() - b.expiresTime.getTime() || a.id - b.id)
      .map((g) => ({ id: g.id, tokensTotal: g.tokensTotal, tokensUsed: g.tokensUsed, tokensReserved: g.tokensReserved, expiresTime: g.expiresTime }));
  }

  async addReservationInTx(_exec: Queryable, grantId: number, tokens: number): Promise<void> {
    const g = this.grants.get(grantId);
    if (!g) throw new Error('grant missing');
    g.tokensReserved += tokens;
  }

  async settleInTx(_exec: Queryable, grantId: number, release: number, charge: number): Promise<void> {
    const g = this.grants.get(grantId);
    if (!g) throw new Error('grant missing');
    g.tokensReserved -= Math.min(g.tokensReserved, release);
    g.tokensUsed += charge;
    if (g.status === 'active' && g.tokensUsed >= g.tokensTotal && g.tokensReserved === 0) g.status = 'exhausted';
  }

  async availability(userId: number, now: Date): Promise<AiGrantAvailability> {
    let remaining = 0;
    let count = 0;
    for (const g of this.grants.values()) {
      if (g.userId !== userId || g.status !== 'active' || g.expiresTime.getTime() <= now.getTime()) continue;
      remaining += Math.max(0, g.tokensTotal - g.tokensUsed - g.tokensReserved);
      count += 1;
    }
    return { remaining, count };
  }
}