import type {
  IUserRepo,
  IRefreshTokenRepo,
  IPlanRepo,
  IPlanFeatureDefRepo,
  IPersonalSubscriptionRepo,
  IOrganizationRepo,
  IOrganizationSubscriptionRepo,
  IMembershipRepo,
  IAuditRepo,
  IOrderRepo,
  IInvoiceRepo,
  AdminUserRow,
  AdminOrgRow,
  AuditFilter,
} from '../repository/interfaces.js';
import type { Queryable } from '../repository/mysql/db.js';
import type { AuditEvent, Plan, PlanFeatureDef, Order, Invoice } from '../domain/entities.js';
import type { UserStatus, InvoiceStatus } from '../domain/enums.js';
import {
  EntityNotFoundError,
  ForbiddenError,
  SubscriptionVersionConflictError,
  PlanVersionConflictError,
  ExportTooLargeError,
  ValidationError,
  OrderInvalidStateError,
} from '../domain/errors.js';
import { AuditWriter } from './auditWriter.js';
import { auditDto, toCsv } from './auditSerialize.js';
import { validateFeatureValue, FREE_PLAN_CODES } from './planFeatureValidation.js';
import type { RateLimitService } from './rateLimitService.js';

/** 平台审计导出单次上限（§6）。 */
const MAX_EXPORT_ROWS = 10_000;
/** 审计查询最大时间跨度（§6）。 */
const MAX_AUDIT_SPAN_MS = 31 * 24 * 3600 * 1000;
/** 组织席位上限：与 migrations/006 SMALLINT UNSIGNED 列一致（上限 65535）。 */
export const MAX_SEAT_LIMIT = 65535;

/**
 * 校验订阅到期时间与周期起点的关系（服务层最终边界）。
 *
 * 拒绝「已过期」与「早于周期起点」的到期时间：否则 status='active' 的订阅会
 * 带一个已失效或倒置的权益窗口，权益展示与业务语义脱节。`null`（永久/未设
 * 到期）放行。
 */
function assertValidPeriodEnd(periodStartTime: Date, periodEndTime: Date | null): void {
  if (periodEndTime === null) return;
  if (periodEndTime.getTime() <= Date.now()) {
    throw new ValidationError('periodEndTime must be in the future');
  }
  if (periodEndTime.getTime() < periodStartTime.getTime()) {
    throw new ValidationError('periodEndTime must not be earlier than periodStartTime');
  }
}

export interface AuditExport {
  content: string;
  filename: string;
  contentType: string;
}

export interface ConsoleAdminDeps {
  userRepo: IUserRepo;
  refreshTokenRepo: IRefreshTokenRepo;
  planRepo: IPlanRepo;
  featureDefRepo: IPlanFeatureDefRepo;
  personalSubscriptionRepo: IPersonalSubscriptionRepo;
  organizationRepo: IOrganizationRepo;
  organizationSubscriptionRepo: IOrganizationSubscriptionRepo;
  membershipRepo: IMembershipRepo;
  auditRepo: IAuditRepo;
  orderRepo: IOrderRepo;
  invoiceRepo: IInvoiceRepo;
  auditWriter: AuditWriter;
  /** 可选：用于受限读审计按 5min 窗口聚合（防高频读刷爆审计表）。 */
  rateLimiter?: RateLimitService;
}

export interface Page<T> {
  items: T[];
  /** 下一页的 keyset 游标（id 数值）；null 表示无下一页。 */
  nextId: number | null;
}

/**
 * 平台运营业务逻辑（P3 切片 4）：用户/组织/订阅/审计的受限读与高危写。
 * 读操作逐请求写受限读审计；写操作由路由以幂等回执包裹，本服务提供 *InTx 变体。
 */
export class ConsoleAdminService {
  private readonly userRepo: IUserRepo;
  private readonly refreshTokenRepo: IRefreshTokenRepo;
  private readonly planRepo: IPlanRepo;
  private readonly featureDefRepo: IPlanFeatureDefRepo;
  private readonly personalSubscriptionRepo: IPersonalSubscriptionRepo;
  private readonly organizationRepo: IOrganizationRepo;
  private readonly organizationSubscriptionRepo: IOrganizationSubscriptionRepo;
  private readonly membershipRepo: IMembershipRepo;
  private readonly auditRepo: IAuditRepo;
  private readonly orderRepo: IOrderRepo;
  private readonly invoiceRepo: IInvoiceRepo;
  private readonly auditWriter: AuditWriter;
  private readonly rateLimiter?: RateLimitService;

  constructor(deps: ConsoleAdminDeps) {
    this.userRepo = deps.userRepo;
    this.refreshTokenRepo = deps.refreshTokenRepo;
    this.planRepo = deps.planRepo;
    this.featureDefRepo = deps.featureDefRepo;
    this.personalSubscriptionRepo = deps.personalSubscriptionRepo;
    this.organizationRepo = deps.organizationRepo;
    this.organizationSubscriptionRepo = deps.organizationSubscriptionRepo;
    this.membershipRepo = deps.membershipRepo;
    this.auditRepo = deps.auditRepo;
    this.orderRepo = deps.orderRepo;
    this.invoiceRepo = deps.invoiceRepo;
    this.auditWriter = deps.auditWriter;
    this.rateLimiter = deps.rateLimiter;
  }

  // ── 用户 ──

  /**
   * 受限读审计按 5min 窗口聚合：同一管理员、同一读类型在窗口内只落一条审计，
   * 防止高频受限读刷爆审计表。未注入 rateLimiter 时退化为逐请求写（测试装配）。
   */
  private async auditRestrictedRead(
    actorUserId: number,
    eventType: 'admin.users.read' | 'admin.organizations.read' | 'admin.audit.read' | 'admin.orders.read' | 'admin.invoices.read' | 'admin.plans.read',
  ): Promise<void> {
    if (!this.rateLimiter) {
      this.auditWriter.write({ eventType, result: 'success', actorUserId, actorRole: 'platform_admin' });
      return;
    }
    const count = await this.rateLimiter.increment(`admin-read-audit:${actorUserId}:${eventType}`, 300);
    if (count === 1) {
      this.auditWriter.write({ eventType, result: 'success', actorUserId, actorRole: 'platform_admin' });
    }
  }

  async listUsers(actorUserId: number, input: {
    emailExact?: string;
    userId?: number;
    status?: UserStatus;
    planCode?: string;
    createdFrom?: Date;
    createdTo?: Date;
    cursor?: number;
    limit: number;
  }): Promise<Page<AdminUserRow>> {
    const rows = await this.userRepo.listUsers({ ...input, limit: input.limit + 1 });
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    await this.auditRestrictedRead(actorUserId, 'admin.users.read');
    return { items, nextId: hasMore ? items[items.length - 1].userId : null };
  }

  async resolvePlanInTx(tx: Queryable, planCode: string): Promise<Plan> {
    const plan = await this.planRepo.findByCodeInTx(tx, planCode);
    if (!plan || plan.status !== 'active') throw new ValidationError('unknown or inactive plan');
    return plan;
  }

  // ── 套餐管理（平台运营）──

  async listPlansForAdmin(actorUserId: number): Promise<Plan[]> {
    await this.auditRestrictedRead(actorUserId, 'admin.plans.read');
    return this.planRepo.listAll();
  }

  async listFeatureDefs(): Promise<PlanFeatureDef[]> {
    return this.featureDefRepo.listAll();
  }

  /**
   * 保存套餐（元数据 + 特性整组替换，单次 version CAS）。
   * 兜底档（free/organization_free）不可归档——否则权益派生 fail-closed 会让全站读路径 500。
   * 特性键必须已定义、取值按 def 的 value_type 校验（禁止 NaN/负数/字符串布尔）。
   */
  async updatePlanInTx(tx: Queryable, actorUserId: number, input: {
    id: number; name: string; priceCents: number; billingUnit: Plan['billingUnit'];
    sortOrder: number; status: Plan['status'];
    features: ReadonlyArray<{ featureKey: string; value: unknown }>;
    expectedVersion: number;
    reason: string;
  }): Promise<Plan> {
    const plan = await this.planRepo.findByIdInTx(tx, input.id);
    if (!plan) throw new EntityNotFoundError('plan', input.id);
    if (FREE_PLAN_CODES.has(plan.code) && input.status !== 'active') {
      throw new ValidationError('fallback plan cannot be archived');
    }
    if (!input.name || input.name.length > 64) throw new ValidationError('invalid plan name');
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0) throw new ValidationError('invalid price');
    if (input.billingUnit !== 'month' && input.billingUnit !== 'seat-month') throw new ValidationError('invalid billing unit');
    if (!Number.isInteger(input.sortOrder)) throw new ValidationError('invalid sort order');
    if (input.status !== 'active' && input.status !== 'archived') throw new ValidationError('invalid status');
    for (const f of input.features) {
      const def = await this.featureDefRepo.findByKey(f.featureKey);
      if (!def) throw new ValidationError(`unknown feature: ${f.featureKey}`);
      validateFeatureValue(def, f.value);
    }

    const ok = await this.planRepo.saveInTx(tx, {
      id: plan.id, name: input.name, priceCents: input.priceCents, billingUnit: input.billingUnit,
      sortOrder: input.sortOrder, status: input.status, features: input.features, expectedVersion: input.expectedVersion,
    });
    if (!ok) throw new PlanVersionConflictError(plan.version);
    await this.auditWriter.writeInTx(tx, {
      eventType: 'admin.plan.updated', result: 'success', actorUserId, actorRole: 'platform_admin',
      targetType: 'plan', targetId: String(plan.id), reason: input.reason,
    });
    const updated = await this.planRepo.findByIdInTx(tx, plan.id);
    if (!updated) throw new EntityNotFoundError('plan', plan.id);
    return updated;
  }

  async upsertFeatureDefInTx(tx: Queryable, actorUserId: number, input: {
    key: string; kind: PlanFeatureDef['kind']; label: PlanFeatureDef['label'];
    valueType: PlanFeatureDef['valueType']; unit: string | null; sortOrder: number;
    reason: string;
  }): Promise<PlanFeatureDef> {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(input.key)) throw new ValidationError('invalid feature key');
    if (!['personal', 'organization', 'both'].includes(input.kind)) throw new ValidationError('invalid feature kind');
    if (!['bool', 'number', 'bytes', 'stringList', 'enum'].includes(input.valueType)) throw new ValidationError('invalid value type');
    if (!Number.isInteger(input.sortOrder)) throw new ValidationError('invalid sort order');
    if (!input.label?.en || !input.label?.zh) throw new ValidationError('label requires en and zh');
    const { reason, ...defInput } = input;
    await this.featureDefRepo.upsertInTx(tx, defInput);
    await this.auditWriter.writeInTx(tx, {
      eventType: 'admin.plan_feature_def.updated', result: 'success', actorUserId, actorRole: 'platform_admin',
      targetType: 'plan_feature_def', targetId: input.key, reason,
    });
    const def = await this.featureDefRepo.findByKey(input.key);
    if (!def) throw new EntityNotFoundError('plan feature def', input.key);
    return def;
  }

  // ── 用户状态（禁用撤销会话）──

  async setUserStatusInTx(
    tx: Queryable,
    actorUserId: number,
    targetUserId: number,
    status: UserStatus,
    reason: string,
  ): Promise<{ userId: string; status: UserStatus }> {
    if (targetUserId === actorUserId && status === 'disabled') {
      throw new ForbiddenError('cannot disable own account');
    }
    const user = await this.userRepo.lockById(tx, targetUserId);
    if (!user) throw new EntityNotFoundError('user', targetUserId);
    if (user.status === status) return { userId: String(user.id), status: user.status };

    if (status === 'disabled') {
      await this.userRepo.updateStatusInTx(tx, user.id, 'disabled');
      await this.userRepo.incrementSessionVersion(tx, user.id);
      await this.refreshTokenRepo.revokeAllForUser(tx, user.id, new Date());
    } else {
      await this.userRepo.updateStatusInTx(tx, user.id, 'active');
    }

    await this.auditWriter.writeInTx(tx, {
      eventType: status === 'disabled' ? 'admin.user.disabled' : 'admin.user.enabled',
      result: 'success',
      actorUserId,
      actorRole: 'platform_admin',
      targetType: 'user',
      targetId: String(user.id),
      reason,
    });
    return { userId: String(user.id), status };
  }

  // ── 个人订阅调整（乐观并发）──

  async adjustUserSubscriptionInTx(
    tx: Queryable,
    actorUserId: number,
    targetUserId: number,
    params: {
      planId: number;
      periodEndTime: Date | null;
      reason: string;
      expectedVersion: number;
    },
  ): Promise<{ subscriptionVersion: number }> {
    const sub = await this.personalSubscriptionRepo.findByUserIdForUpdate(tx, targetUserId);
    if (!sub) throw new EntityNotFoundError('subscription', targetUserId);
    if (params.expectedVersion !== sub.version) throw new SubscriptionVersionConflictError(sub.version);
    assertValidPeriodEnd(sub.periodStartTime, params.periodEndTime);

    const ok = await this.personalSubscriptionRepo.update(tx, {
      id: sub.id,
      planId: params.planId,
      status: 'active',
      periodEndTime: params.periodEndTime,
      expectedVersion: params.expectedVersion,
    });
    if (!ok) throw new SubscriptionVersionConflictError(sub.version);

    await this.auditWriter.writeInTx(tx, {
      eventType: 'admin.user.subscription.changed',
      result: 'success',
      actorUserId,
      actorRole: 'platform_admin',
      targetType: 'user',
      targetId: String(targetUserId),
      reason: params.reason,
    });
    return { subscriptionVersion: sub.version + 1 };
  }

  // ── 组织 ──

  async listOrganizations(actorUserId: number, input: {
    namePrefix?: string;
    status?: 'active' | 'closed';
    planCode?: string;
    cursor?: number;
    limit: number;
  }): Promise<Page<AdminOrgRow>> {
    const rows = await this.organizationRepo.listForAdmin({ ...input, limit: input.limit + 1 });
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    await this.auditRestrictedRead(actorUserId, 'admin.organizations.read');
    return { items, nextId: hasMore ? items[items.length - 1].organizationId : null };
  }

  async listOrders(actorUserId: number, input: {
    userId?: number;
    status?: Order['status'];
    channel?: Order['channel'];
    planCode?: string;
    createdFrom?: Date;
    createdTo?: Date;
    cursor?: number;
    limit: number;
  }): Promise<Page<Order>> {
    const rows = await this.orderRepo.listAll({ ...input, limit: input.limit + 1 });
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    await this.auditRestrictedRead(actorUserId, 'admin.orders.read');
    return { items, nextId: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * 人工退款登记（§状态机）：仅 `paid` / `fulfilled` 可退，置为 `refunded` 并登记 reason。
   * 只改本地状态、不调用任何支付渠道退款 API（真实退款走部署后人工验收）。
   */
  async refundOrderInTx(
    tx: Queryable,
    actorUserId: number,
    orderNo: string,
    reason: string,
  ): Promise<{ orderNo: string; status: Order['status'] }> {
    const normalizedReason = (reason ?? '').trim();
    if (!normalizedReason) {
      throw new ValidationError('refund reason is required');
    }
    const order = await this.orderRepo.findByOrderNoForUpdate(tx, orderNo);
    if (!order) throw new EntityNotFoundError('order', orderNo);
    if (order.status !== 'paid' && order.status !== 'fulfilled') {
      throw new OrderInvalidStateError('only paid or fulfilled orders can be refunded');
    }
    // 已开具(issued)发票的订单不得直接退款：否则形成「订单已退款 + 发票已开具」的矛盾账。
    // 业务上需先冲红/作废发票（当前不实现，直接拒绝并提示运营人工处理）。
    if (await this.invoiceRepo.hasIssuedForOrder(tx, order.id)) {
      throw new OrderInvalidStateError('order has an issued invoice and cannot be refunded directly');
    }
    const ok = await this.orderRepo.advance(tx, {
      id: order.id,
      expectedStatus: order.status,
      status: 'refunded',
      channelTradeNo: null,
      paidTime: null,
    });
    if (!ok) throw new OrderInvalidStateError('order changed concurrently');
    await this.auditWriter.writeInTx(tx, {
      eventType: 'admin.order.refunded',
      result: 'success',
      actorUserId,
      actorRole: 'platform_admin',
      targetType: 'order',
      targetId: orderNo,
      reason: normalizedReason,
    });
    return { orderNo, status: 'refunded' };
  }

  // ── 发票 ──

  async listInvoicesForAdmin(actorUserId: number, input: {
    userId?: number;
    status?: InvoiceStatus;
    cursor?: number;
    limit: number;
  }): Promise<Page<Invoice>> {
    const rows = await this.invoiceRepo.listAll({ ...input, limit: input.limit + 1 });
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    await this.auditRestrictedRead(actorUserId, 'admin.invoices.read');
    return { items, nextId: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * 运营处理发票：`requested → issued | rejected | failed`。`rejected`/`failed` 必须给
   * reason（记录并展示给用户）；只改状态 + 原因，不生成发票文件本身。
   */
  async setInvoiceStatusInTx(
    tx: Queryable,
    actorUserId: number,
    invoiceId: number,
    status: 'issued' | 'rejected' | 'failed',
    reason: string | null,
  ): Promise<{ invoiceId: string; status: InvoiceStatus }> {
    const inv = await this.invoiceRepo.findByIdForUpdate(tx, invoiceId);
    if (!inv) throw new EntityNotFoundError('invoice', invoiceId);
    if (inv.status !== 'requested') throw new OrderInvalidStateError('only a requested invoice can be processed');

    // 开具前校验归属订单仍为 fulfilled：退款/失效后不得再开票（发票申请时的 fulfilled 校验见
    // invoiceService）。无订单归属（orderId == null）的人工记录不受此约束。
    if (status === 'issued' && inv.orderId != null) {
      const order = await this.orderRepo.findByIdForUpdate(tx, inv.orderId);
      if (!order || order.status !== 'fulfilled') {
        throw new OrderInvalidStateError('invoice order is no longer fulfilled');
      }
    }

    const finalReason = (reason ?? '').trim();
    if ((status === 'rejected' || status === 'failed') && !finalReason) {
      throw new ValidationError('reason is required when rejecting or failing an invoice');
    }

    const ok = await this.invoiceRepo.advance(tx, {
      id: inv.id,
      expectedStatus: 'requested',
      status,
      reason: status === 'issued' ? null : finalReason,
    });
    if (!ok) throw new OrderInvalidStateError('invoice changed concurrently');

    const eventType = status === 'issued' ? 'admin.invoice.issued' : (status === 'rejected' ? 'admin.invoice.rejected' : 'admin.invoice.failed');
    await this.auditWriter.writeInTx(tx, {
      eventType,
      result: 'success',
      actorUserId,
      actorRole: 'platform_admin',
      targetType: 'invoice',
      targetId: String(inv.id),
      reason: status === 'issued' ? undefined : finalReason,
    });
    return { invoiceId: String(inv.id), status };
  }

  async adjustOrganizationSubscriptionInTx(
    tx: Queryable,
    actorUserId: number,
    organizationId: number,
    params: {
      planId: number;
      seatLimit: number;
      periodEndTime: Date | null;
      reason: string;
      expectedVersion: number;
    },
  ): Promise<{ subscriptionVersion: number }> {
    const org = await this.organizationRepo.lockById(tx, organizationId);
    if (!org) throw new EntityNotFoundError('organization', organizationId);
    const sub = await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
    if (!sub) throw new EntityNotFoundError('organization subscription', organizationId);
    if (params.expectedVersion !== sub.version) throw new SubscriptionVersionConflictError(sub.version);
    if (params.seatLimit > MAX_SEAT_LIMIT) throw new ValidationError('seatLimit exceeds maximum 65535');
    assertValidPeriodEnd(sub.periodStartTime, params.periodEndTime);

    const activeMembers = await this.membershipRepo.countActive(tx, organizationId);
    const validInvited = await this.membershipRepo.countValidInvited(tx, organizationId, new Date());
    if (params.seatLimit < activeMembers + validInvited) {
      throw new ValidationError('seatLimit cannot be below occupied seats');
    }

    const ok = await this.organizationSubscriptionRepo.update(tx, {
      id: sub.id,
      planId: params.planId,
      seatLimit: params.seatLimit,
      status: 'active',
      periodEndTime: params.periodEndTime,
      expectedVersion: params.expectedVersion,
    });
    if (!ok) throw new SubscriptionVersionConflictError(sub.version);

    await this.auditWriter.writeInTx(tx, {
      eventType: 'admin.organization.subscription.changed',
      result: 'success',
      actorUserId,
      actorRole: 'platform_admin',
      targetType: 'organization',
      targetId: String(organizationId),
      organizationId,
      reason: params.reason,
    });
    return { subscriptionVersion: sub.version + 1 };
  }

  // ── 审计查询 / 导出 ──

  /**
   * 把可选时间范围规范为 ≤31 天的有界窗口：toTime 缺省为 now、fromTime 缺省为
   * toTime-31d；显式跨度 > 31 天或首尾颠倒一律拒绝（§6 审计披露边界）。
   */
  resolveAuditSpan(fromTime?: Date, toTime?: Date): { fromTime: Date; toTime: Date } {
    const to = toTime ?? new Date();
    const from = fromTime ?? new Date(to.getTime() - MAX_AUDIT_SPAN_MS);
    if (from.getTime() > to.getTime()) throw new ValidationError('invalid audit time range');
    if (to.getTime() - from.getTime() > MAX_AUDIT_SPAN_MS) throw new ValidationError('audit time span exceeds 31 days');
    return { fromTime: from, toTime: to };
  }

  async queryAudit(actorUserId: number, input: AuditFilter): Promise<Page<AuditEvent>> {
    const span = this.resolveAuditSpan(input.fromTime, input.toTime);
    const filter: AuditFilter = { ...input, fromTime: span.fromTime, toTime: span.toTime };
    const rows = await this.auditRepo.search({ ...filter, limit: input.limit + 1 });
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    await this.auditRestrictedRead(actorUserId, 'admin.audit.read');
    return { items, nextId: hasMore ? items[items.length - 1].id : null };
  }

  async exportAuditInTx(
    tx: Queryable,
    actorUserId: number,
    input: Omit<AuditFilter, 'cursor' | 'limit'>,
    format: 'csv' | 'json',
  ): Promise<AuditExport> {
    const span = this.resolveAuditSpan(input.fromTime, input.toTime);
    const filter = { ...input, fromTime: span.fromTime, toTime: span.toTime };

    const total = await this.auditRepo.countInTx(tx, filter);
    if (total > MAX_EXPORT_ROWS) throw new ExportTooLargeError();
    const rows = await this.auditRepo.searchInTx(tx, { ...filter, limit: MAX_EXPORT_ROWS });

    // 审计事件与导出读取同事务（幂等回执下重放不重复审计，§6.1/§9）。
    await this.auditWriter.writeInTx(tx, {
      eventType: 'admin.audit.export',
      result: 'success',
      actorUserId,
      actorRole: 'platform_admin',
    });

    const dtos = rows.map(auditDto);
    const fromLabel = span.fromTime.toISOString().slice(0, 10);
    const toLabel = span.toTime.toISOString().slice(0, 10);
    const content = format === 'json' ? JSON.stringify(dtos) : toCsv(dtos);
    return {
      content,
      filename: `audit-${fromLabel}-${toLabel}.${format}`,
      contentType: format === 'json' ? 'application/json' : 'text/csv',
    };
  }
}