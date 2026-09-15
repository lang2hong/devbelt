import type {
  IdempotencyReceipt,
  Order,
  Payment,
  Invoice,
} from "../../domain/entities.js";
import type { Queryable } from "../mysql/db.js";
import type {
  AdminOrderFilter,
  AdminInvoiceFilter,
} from "./admin.js";

/** 仓储接口 · billing（自 interfaces.ts 按聚合拆分，纯类型移动）。 */

export interface IIdempotencyReceiptRepo {
  /** 事务内插入 processing 回执（唯一键冲突抛 ER_DUP_ENTRY，由服务层捕获转重放/冲突）。 */
  createProcessing(exec: Queryable, input: {
    actorUserId: number;
    sessionId: string;
    method: string;
    normalizedPath: string;
    idempotencyKey: string;
    requestDigest: Buffer;
    expiresTime: Date;
  }): Promise<IdempotencyReceipt>;
  /** 只读查回执（预检，连接池）。 */
  findByKey(actorUserId: number, sessionId: string, method: string, normalizedPath: string, idempotencyKey: string): Promise<IdempotencyReceipt | undefined>;
  /** 事务内置 completed：http_status + 规范 JSON 响应体。 */
  complete(exec: Queryable, id: number, httpStatus: number, responseBody: string): Promise<void>;
  /** 删除已过期（expires_time < before）的回执行。返回删除行数。 */
  prune(exec: Queryable, before: Date, limit: number): Promise<number>;
}

export interface IOrderRepo {
  create(input: {
    orderNo: string;
    userId: number;
    planCode: string;
    amountCents: number;
    channel: Order['channel'];
    expiresTime: Date;
  }): Promise<Order>;
  /** 对外订单号只读查找。 */
  findByOrderNo(orderNo: string): Promise<Order | undefined>;
  /** 事务内按 order_no 锁定订单行（回调/状态推进的序列化点，§状态机）。 */
  findByOrderNoForUpdate(exec: Queryable, orderNo: string): Promise<Order | undefined>;
  /** 事务内按主键 id 锁定订单行（发票开具前校验订单仍为 fulfilled 的序列化点）。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<Order | undefined>;
  /** 事务内推进状态：`WHERE id=? AND status=expectedStatus`，返回是否命中（幂等防重复回调）。 */
  advance(exec: Queryable, input: {
    id: number;
    expectedStatus: Order['status'];
    status: Order['status'];
    channelTradeNo: string | null;
    paidTime: Date | null;
  }): Promise<boolean>;
  /** 用户订单历史（keyset cursor，DESC by id）。 */
  listByUser(userId: number, cursor: number | undefined, limit: number): Promise<Order[]>;
  /** 平台订单列表（跨用户，多维过滤，keyset cursor DESC by id）。 */
  listAll(input: AdminOrderFilter): Promise<Order[]>;
  /** 同 (user, plan, channel) 未过期 pending 订单（下单去重：复用原订单，防重复付款，§P4）。 */
  findPendingByUserAndPlan(userId: number, planCode: string, channel: Order['channel']): Promise<Order | undefined>;
  /** 过期 pending 订单 sweep：把超时未支付的 pending 订单批量置为 expired，返回受影响行数。 */
  expirePending(now: Date, limit: number): Promise<number>;
}

export interface IPaymentRepo {
  create(exec: Queryable, input: {
    orderId: number;
    channel: Payment['channel'];
    channelTradeNo: string;
    amountCents: number;
    rawNotification: string | null;
    signatureVerified: boolean;
    result: Payment['result'];
  }): Promise<Payment>;
  /** 按渠道交易号查流水（回调幂等：重复回调以唯一键兜底 + 此查询判定 duplicate）。 */
  findByChannelTradeNo(exec: Queryable, channel: Payment['channel'], channelTradeNo: string): Promise<Payment | undefined>;
}

export interface IPaymentCallbackNonceRepo {
  /**
   * 在**调用方事务内**记录回调 nonce（SHA-256 摘要）；首次记录返回 true，重复（重放）返回 false。
   *
   * 必须与订单推进同事务：若在事务外先落 nonce，业务步骤失败后 nonce 已提交，
   * 渠道重试会被误判为重放而返回 ack，订单永远停在 pending。
   */
  insertIfAbsent(exec: Queryable, channel: Payment['channel'], nonceHash: string, expiresTime: Date): Promise<boolean>;
  /** 删除 `expires_time < NOW()` 的过期 nonce（重放去重记录，属垃圾行）。返回删除行数。 */
  purgeExpired(exec: Queryable): Promise<number>;
}

export interface IInvoiceRepo {
  create(exec: Queryable, input: {
    userId: number;
    orderId: number | null;
    title: string;
    taxNo: string | null;
    email: string;
    amountCents: number;
  }): Promise<Invoice>;
  /** 用户发票申请历史（keyset cursor，DESC by id）。 */
  listByUser(userId: number, cursor: number | undefined, limit: number): Promise<Invoice[]>;
  /** 事务内按 id 锁定发票行（运营处理的序列化点）。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<Invoice | undefined>;
  /** 事务内推进状态并登记原因：`WHERE id=? AND status=expectedStatus`，返回是否命中。 */
  advance(exec: Queryable, input: {
    id: number;
    expectedStatus: Invoice['status'];
    status: Invoice['status'];
    reason: string | null;
  }): Promise<boolean>;
  /** 该订单是否已存在 `issued` 状态的发票（退款前校验，锁订单行后调用防矛盾账）。 */
  hasIssuedForOrder(exec: Queryable, orderId: number): Promise<boolean>;
  /** 平台发票列表（跨用户，多维过滤，keyset cursor DESC by id）。 */
  listAll(input: AdminInvoiceFilter): Promise<Invoice[]>;
}
