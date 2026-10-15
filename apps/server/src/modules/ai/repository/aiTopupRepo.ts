import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';

/**
 * AI 加油包仓储（P9.1）：SKU 目录 + 加油包订单 + `ai_quota_grants` 额度账本。
 *
 * 账本不变量：
 * - 订单是唯一资金事实源；`ai_quota_grants.order_id` 唯一键（`uq_grants_order`）是入账幂等锚点
 *   （D17：manual/渠道双来源都收敛到订单行后入账，重放为 no-op）；
 * - grants 行级 `tokens_used + tokens_reserved ≤ tokens_total`（SQL 侧 LEAST 防无符号下溢，
 *   逻辑侧预占/结算以行为单位串行）；
 * - 过期由 `expires_time > now` 过滤 + 惰性状态翻转（`expireStaleInTx`），不参与可用额度。
 */

export interface AiTopupSku {
  code: string;
  label: { en: string; zh: string };
  tokens: number;
  priceCents: number;
  validDays: number;
  status: 'active' | 'disabled';
  sortOrder: number;
}

export interface AiTopupOrder {
  id: number;
  orderNo: string;
  userId: number;
  skuCode: string;
  amountCents: number;
  status: 'pending' | 'paid' | 'fulfilled' | 'failed' | 'refunded' | 'expired';
  channel: 'wechat' | 'alipay' | 'manual';
  expiresTime: Date;
}

export interface AiGrantRow {
  id: number;
  tokensTotal: number;
  tokensUsed: number;
  tokensReserved: number;
  expiresTime: Date;
}

/** 可用额度汇总（配额快照/409 上下文用）。 */
export interface AiGrantAvailability {
  /** 活跃未过期 grants 的剩余合计（total - used - reserved）。 */
  remaining: number;
  /** 活跃未过期 grants 条数。 */
  count: number;
}

/** 管理视图的 grant 明细行（含状态与订单关联，P9.1b 用户配额查询）。 */
export interface AiGrantDetail extends AiGrantRow {
  skuCode: string;
  status: 'active' | 'exhausted' | 'expired' | 'refunded';
  orderId: number;
}

export interface IAiGrantRepo {
  /** 惰性过期翻转（active 且 expires_time ≤ now → 'expired'），先于任何可读/锁查询。 */
  expireStaleInTx(exec: Queryable, userId: number, now: Date): Promise<void>;
  /**
   * 事务内锁同用户活跃未过期 grants（`FOR UPDATE`，按 expires_time ASC, id ASC 保证 FIFO 顺序）。
   * 调用前先 `expireStaleInTx` 以清掉过期行。
   */
  lockActiveInTx(exec: Queryable, userId: number, now: Date): Promise<AiGrantRow[]>;
  /** 预占累加（tokens_reserved += n）。 */
  addReservationInTx(exec: Queryable, grantId: number, tokens: number): Promise<void>;
  /**
   * 结算单条 grant：释放本行预占 + 入账实际用量（`used += charge`，`reserved -= LEAST(reserved, release)`）。
   * 用尽（used ≥ total 且无剩余预占）翻 'exhausted'（仅当仍为 'active'，不覆盖 'refunded'）。
   */
  settleInTx(exec: Queryable, grantId: number, release: number, charge: number): Promise<void>;
  /** 只读可用汇总（无锁；配额快照/409 用）——过期行不计，不翻转状态。 */
  availability(userId: number, now: Date): Promise<AiGrantAvailability>;
}

export interface IAiTopupRepo extends IAiGrantRepo {
  /** 上架 SKU（status='active'，按 sort_order ASC, id ASC）。 */
  listActiveSkus(): Promise<AiTopupSku[]>;
  /** 全量 SKU（含 disabled；管理后台 SKU 管理，P9.1b）。 */
  listSkusAll(): Promise<AiTopupSku[]>;
  /** 按 code 查 SKU（含 disabled；下单校验用）。 */
  findSkuByCode(code: string): Promise<AiTopupSku | undefined>;
  /** 事务内按 code 查 SKU（幂等回执 business 内的当前价读取，P9.1b）。 */
  findSkuByCodeInTx(exec: Queryable, code: string): Promise<AiTopupSku | undefined>;
  /** 事务内更新 SKU（价格/状态/文案/有效期/排序；管理后台，P9.1b）。返回是否命中。 */
  updateSkuInTx(
    exec: Queryable,
    code: string,
    patch: { priceCents?: number; status?: 'active' | 'disabled'; label?: { en: string; zh: string }; validDays?: number; sortOrder?: number },
  ): Promise<boolean>;
  /** 用户全部 grants（含 exhausted/expired/refunded；管理后台配额明细，P9.1b）。 */
  listGrantsByUser(userId: number, limit: number): Promise<AiGrantDetail[]>;

  /** 新建加油包订单（channel/purpose='topup' 存档；同一事务内不入账）。返回订单行。 */
  insertTopupOrderInTx(
    exec: Queryable,
    input: { orderNo: string; userId: number; skuCode: string; amountCents: number; channel: 'wechat' | 'alipay' | 'manual'; status: 'pending' | 'fulfilled'; expiresTime: Date },
  ): Promise<AiTopupOrder>;
  /** 事务内按订单号锁行（入账/退款序列化）。 */
  lockOrderByNoInTx(exec: Queryable, orderNo: string): Promise<AiTopupOrder | undefined>;
  /**
   * 同人同 SKU 同渠道的未过期 pending 订单（下单复用，P1b 语义；P9.1c）。
   * 防双击/重试重复付款；复用剩余寿命校验由调用方执行（不足 1m 不复用）。
   */
  findPendingByUserAndSku(userId: number, skuCode: string, channel: 'wechat' | 'alipay'): Promise<AiTopupOrder | undefined>;
  /** 订单状态推进（幂等由调用方在行锁内判定；返回是否命中期望前态）。 */
  setOrderStatusInTx(
    exec: Queryable,
    orderId: number,
    from: AiTopupOrder['status'],
    to: AiTopupOrder['status'],
  ): Promise<boolean>;

  /**
   * 入账一条 grant（`INSERT ... ON DUPLICATE KEY UPDATE id = id` 幂等）。
   * 返回 false 表示该订单已入账过（重放），调用方仍应确保订单状态推进到 fulfilled。
   */
  insertGrantInTx(
    exec: Queryable,
    input: { userId: number; orderId: number; skuCode: string; tokens: number; expiresTime: Date },
  ): Promise<boolean>;
  /** 退款撤销：该订单 grant 剩余额度作废（used 保留审计），status → 'refunded'（重复调用幂等）。 */
  refundGrantByOrderInTx(exec: Queryable, orderId: number): Promise<void>;
}

const SKU_COLS = 'code, label_json, tokens, price_cents, valid_days, status, sort_order';
const GRANT_COLS = 'id, tokens_total, tokens_used, tokens_reserved, expires_time';
const ORDER_COLS = 'id, order_no, user_id, sku_code, amount_cents, status, channel, expires_time';

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function mapSku(r: Record<string, unknown>): AiTopupSku {
  const label = typeof r.label_json === 'string' ? JSON.parse(r.label_json) : (r.label_json ?? {});
  const l = (label ?? {}) as Record<string, unknown>;
  return {
    code: String(r.code),
    label: { en: typeof l.en === 'string' ? l.en : String(r.code), zh: typeof l.zh === 'string' ? l.zh : String(r.code) },
    tokens: toCount(r.tokens),
    priceCents: toCount(r.price_cents),
    validDays: toCount(r.valid_days),
    status: r.status === 'disabled' ? 'disabled' : 'active',
    sortOrder: Number(r.sort_order) || 0,
  };
}

function mapGrant(r: Record<string, unknown>): AiGrantRow {
  return {
    id: Number(r.id),
    tokensTotal: toCount(r.tokens_total),
    tokensUsed: toCount(r.tokens_used),
    tokensReserved: toCount(r.tokens_reserved),
    expiresTime: r.expires_time instanceof Date ? r.expires_time : new Date(String(r.expires_time)),
  };
}

function mapOrder(r: Record<string, unknown>): AiTopupOrder {
  return {
    id: Number(r.id),
    orderNo: String(r.order_no),
    userId: Number(r.user_id),
    skuCode: String(r.sku_code ?? ''),
    amountCents: toCount(r.amount_cents),
    status: String(r.status) as AiTopupOrder['status'],
    channel: String(r.channel) as AiTopupOrder['channel'],
    expiresTime: r.expires_time instanceof Date ? r.expires_time : new Date(String(r.expires_time)),
  };
}

export class MysqlAiTopupRepo implements IAiTopupRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async listActiveSkus(): Promise<AiTopupSku[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT ${SKU_COLS} FROM ai_topup_skus WHERE status = 'active' ORDER BY sort_order ASC, id ASC`,
    );
    return rows.map(mapSku);
  }

  async findSkuByCode(code: string): Promise<AiTopupSku | undefined> {
    const [rows] = await this.db().query<any[]>(
      `SELECT ${SKU_COLS} FROM ai_topup_skus WHERE code = ?`,
      [code],
    );
    return rows[0] ? mapSku(rows[0]) : undefined;
  }

  async findSkuByCodeInTx(exec: Queryable, code: string): Promise<AiTopupSku | undefined> {
    const [rows] = await exec.query<any[]>(
      `SELECT ${SKU_COLS} FROM ai_topup_skus WHERE code = ?`,
      [code],
    );
    return rows[0] ? mapSku(rows[0]) : undefined;
  }

  async listSkusAll(): Promise<AiTopupSku[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT ${SKU_COLS} FROM ai_topup_skus ORDER BY sort_order ASC, id ASC`,
    );
    return rows.map(mapSku);
  }

  async updateSkuInTx(
    exec: Queryable,
    code: string,
    patch: { priceCents?: number; status?: 'active' | 'disabled'; label?: { en: string; zh: string }; validDays?: number; sortOrder?: number },
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.priceCents !== undefined) {
      sets.push('price_cents = ?');
      params.push(patch.priceCents);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.label !== undefined) {
      sets.push('label_json = ?');
      params.push(JSON.stringify(patch.label));
    }
    if (patch.validDays !== undefined) {
      sets.push('valid_days = ?');
      params.push(patch.validDays);
    }
    if (patch.sortOrder !== undefined) {
      sets.push('sort_order = ?');
      params.push(patch.sortOrder);
    }
    if (sets.length === 0) return true;
    const [result] = await exec.query<any>(
      `UPDATE ai_topup_skus SET ${sets.join(', ')} WHERE code = ?`,
      [...params, code],
    );
    return Number(result?.affectedRows ?? 0) > 0;
  }

  async listGrantsByUser(userId: number, limit: number): Promise<AiGrantDetail[]> {
    const [rows] = await this.db().query<any[]>(
      `SELECT id, order_id, sku_code, tokens_total, tokens_used, tokens_reserved, expires_time, status
         FROM ai_quota_grants
        WHERE user_id = ?
        ORDER BY expires_time ASC, id ASC
        LIMIT ${Math.max(1, Math.min(Math.floor(limit), 200))}`,
      [userId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      ...mapGrant(r),
      orderId: Number(r.order_id),
      skuCode: String(r.sku_code ?? ''),
      status: String(r.status) as AiGrantDetail['status'],
    }));
  }

  async insertTopupOrderInTx(
    exec: Queryable,
    input: { orderNo: string; userId: number; skuCode: string; amountCents: number; channel: 'wechat' | 'alipay' | 'manual'; status: 'pending' | 'fulfilled'; expiresTime: Date },
  ): Promise<AiTopupOrder> {
    const [result] = await exec.query<any>(
      `INSERT INTO orders (order_no, user_id, purpose, plan_code, plan_version, sku_code, amount_cents, channel, status, expires_time)
       VALUES (?, ?, 'topup', NULL, 0, ?, ?, ?, ?, ?)`,
      [input.orderNo, input.userId, input.skuCode, input.amountCents, input.channel, input.status, input.expiresTime],
    );
    const [rows] = await exec.query<any[]>(
      `SELECT ${ORDER_COLS} FROM orders WHERE id = ?`,
      [result.insertId],
    );
    const row = rows[0];
    if (!row) throw new Error('topup order insert failed');
    return mapOrder(row);
  }

  async findPendingByUserAndSku(userId: number, skuCode: string, channel: 'wechat' | 'alipay'): Promise<AiTopupOrder | undefined> {
    const [rows] = await this.db().query<any[]>(
      `SELECT ${ORDER_COLS} FROM orders
        WHERE user_id = ? AND purpose = 'topup' AND sku_code = ? AND channel = ? AND status = 'pending' AND expires_time > UTC_TIMESTAMP(3)
        ORDER BY id DESC LIMIT 1`,
      [userId, skuCode, channel],
    );
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }

  async lockOrderByNoInTx(exec: Queryable, orderNo: string): Promise<AiTopupOrder | undefined> {
    const [rows] = await exec.query<any[]>(
      `SELECT ${ORDER_COLS} FROM orders WHERE order_no = ? AND purpose = 'topup' FOR UPDATE`,
      [orderNo],
    );
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }

  async setOrderStatusInTx(
    exec: Queryable,
    orderId: number,
    from: AiTopupOrder['status'],
    to: AiTopupOrder['status'],
  ): Promise<boolean> {
    const [result] = await exec.query<any>(
      `UPDATE orders
          SET status = ?,
              paid_time = CASE WHEN ? = 'fulfilled' AND paid_time IS NULL THEN NOW(3) ELSE paid_time END
        WHERE id = ? AND status = ?`,
      [to, to, orderId, from],
    );
    return Number(result?.affectedRows ?? 0) > 0;
  }

  async insertGrantInTx(
    exec: Queryable,
    input: { userId: number; orderId: number; skuCode: string; tokens: number; expiresTime: Date },
  ): Promise<boolean> {
    const [result] = await exec.query<any>(
      `INSERT INTO ai_quota_grants (user_id, order_id, sku_code, tokens_total, expires_time)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [input.userId, input.orderId, input.skuCode, input.tokens, input.expiresTime],
    );
    // MySQL：insert 新行 affectedRows=1；命中唯一键走 UPDATE id=id 时 affectedRows=0。
    return Number(result?.affectedRows ?? 0) > 0;
  }

  async refundGrantByOrderInTx(exec: Queryable, orderId: number): Promise<void> {
    await exec.query(
      `UPDATE ai_quota_grants
          SET status = 'refunded', tokens_reserved = 0
        WHERE order_id = ? AND status <> 'refunded'`,
      [orderId],
    );
  }

  async expireStaleInTx(exec: Queryable, userId: number, now: Date): Promise<void> {
    await exec.query(
      `UPDATE ai_quota_grants
          SET status = 'expired'
        WHERE user_id = ? AND status = 'active' AND expires_time <= ?`,
      [userId, now],
    );
  }

  async lockActiveInTx(exec: Queryable, userId: number, now: Date): Promise<AiGrantRow[]> {
    const [rows] = await exec.query<any[]>(
      `SELECT ${GRANT_COLS} FROM ai_quota_grants
        WHERE user_id = ? AND status = 'active' AND expires_time > ?
        ORDER BY expires_time ASC, id ASC
        FOR UPDATE`,
      [userId, now],
    );
    return rows.map(mapGrant);
  }

  async addReservationInTx(exec: Queryable, grantId: number, tokens: number): Promise<void> {
    await exec.query(
      `UPDATE ai_quota_grants SET tokens_reserved = tokens_reserved + ? WHERE id = ?`,
      [tokens, grantId],
    );
  }

  async settleInTx(exec: Queryable, grantId: number, release: number, charge: number): Promise<void> {
    // 释放用 `reserved - LEAST(reserved, x)`（避免无符号下溢）；用完翻 exhausted（不覆盖 refunded）。
    await exec.query(
      `UPDATE ai_quota_grants
          SET tokens_reserved = tokens_reserved - LEAST(tokens_reserved, ?),
              tokens_used = tokens_used + ?,
              status = CASE WHEN status = 'active' AND tokens_used + ? >= tokens_total AND tokens_reserved - LEAST(tokens_reserved, ?) = 0
                            THEN 'exhausted' ELSE status END
        WHERE id = ?`,
      [release, charge, charge, release, grantId],
    );
  }

  async availability(userId: number, now: Date): Promise<AiGrantAvailability> {
    const [rows] = await this.db().query<any[]>(
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(tokens_total - tokens_used - tokens_reserved), 0) AS remaining
         FROM ai_quota_grants
        WHERE user_id = ? AND status = 'active' AND expires_time > ?`,
      [userId, now],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return { remaining: toCount(row?.remaining), count: Number(row?.cnt) || 0 };
  }
}