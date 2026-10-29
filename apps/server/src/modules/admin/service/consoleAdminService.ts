import type {
  IUserRepo,
  IRefreshTokenRepo,
  IPlanRepo,
  IPlanFeatureDefRepo,
  IPersonalSubscriptionRepo,
  IAuditRepo,
  IOrderRepo,
  IInvoiceRepo,
  AdminUserRow,
  AuditFilter,
  ISyncStateRepo,
} from '../../../repository/interfaces.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type { AuditEvent, Plan, PlanFeatureDef, Order, Invoice } from '../../../domain/entities.js';
import type { AttachmentStore } from '../../feedback/service/attachmentStore.js';
import type { UserStatus, InvoiceStatus } from '../../../domain/enums.js';
import {
  EntityNotFoundError,
  ForbiddenError,
  SubscriptionVersionConflictError,
  PlanVersionConflictError,
  ExportTooLargeError,
  ValidationError,
  OrderInvalidStateError,
} from '../../../domain/errors.js';
import { AuditWriter } from '../../../service/auditWriter.js';
import { auditDto, toCsv } from '../../../service/auditSerialize.js';
import { validateFeatureValue, FREE_PLAN_CODES } from '../../billing/service/planFeatureValidation.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { SyncRecordService } from '../../db/service/syncRecordService.js';
import type { SyncRecordMetadataRow } from '../../../repository/interfaces.js';
import type {
  AdminOverview,
  FeedbackDetail,
  FeedbackEmailStatus,
  FeedbackEmailTarget,
  FeedbackFilter,
  IFeedbackRepo,
} from '../../../repository/interfaces/feedback.js';
import type { ITelemetryRepo } from '../../../repository/interfaces/telemetry.js';
import type { EmailSender } from '../../auth/service/emailSender.js';

/** 平台审计导出单次上限（§6）。 */
const MAX_EXPORT_ROWS = 10_000;
/** 审计查询最大时间跨度（§6）。 */
const MAX_AUDIT_SPAN_MS = 31 * 24 * 3600 * 1000;

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
  auditRepo: IAuditRepo;
  orderRepo: IOrderRepo;
  invoiceRepo: IInvoiceRepo;
  auditWriter: AuditWriter;
  /** P6：同步状态与记录读面（后台按类型元数据）。 */
  syncStateRepo: ISyncStateRepo;
  syncRecordService: SyncRecordService;
  /** 可选：用于受限读审计按 5min 窗口聚合（防高频读刷爆审计表）。 */
  rateLimiter?: RateLimitService;
  /** 用户反馈（015）。 */
  feedbackRepo: IFeedbackRepo;
  /** 扩展安装/活跃心跳（016）。 */
  telemetryRepo: ITelemetryRepo;
  /** 反馈回复邮件（017）；缺省时选择发邮件会记为 failed。 */
  emailSender?: EmailSender;
  /** 反馈附件存储（021）；缺省时后台无法读取附件。 */
  feedbackAttachments?: AttachmentStore;
}

/** 管理员回复正文上限（与 feedback_replies.body 列宽一致）。 */
export const MAX_FEEDBACK_REPLY = 4000;
/** 粗校验：只用于判断 contact 能否作为收件地址，不做完整 RFC 校验。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** P6：后台按明文类型展示的密文元数据行（不含明文）。 */
export interface SyncKindOverviewRow {
  entityKind: string | null;
  count: number;
  bytes: number;
  lastActivityTime: Date | null;
}

export interface Page<T> {
  items: T[];
  /** 下一页的 keyset 游标（id 数值）；null 表示无下一页。 */
  nextId: number | null;
  /** 首屏总条数（仅无 cursor 的首屏查询返回，后续页省略以省 count）。 */
  total?: number;
}

/**
 * 平台运营业务逻辑（P3 切片 4）：用户/订阅/审计的受限读与高危写。
 * 读操作逐请求写受限读审计；写操作由路由以幂等回执包裹，本服务提供 *InTx 变体。
 */
export class ConsoleAdminService {
  private readonly userRepo: IUserRepo;
  private readonly refreshTokenRepo: IRefreshTokenRepo;
  private readonly planRepo: IPlanRepo;
  private readonly featureDefRepo: IPlanFeatureDefRepo;
  private readonly personalSubscriptionRepo: IPersonalSubscriptionRepo;
  private readonly auditRepo: IAuditRepo;
  private readonly orderRepo: IOrderRepo;
  private readonly invoiceRepo: IInvoiceRepo;
  private readonly auditWriter: AuditWriter;
  private readonly syncStateRepo: ISyncStateRepo;
  private readonly syncRecordService: SyncRecordService;
  private readonly rateLimiter?: RateLimitService;
  private readonly feedbackRepo: IFeedbackRepo;
  private readonly telemetryRepo: ITelemetryRepo;
  private readonly emailSender?: EmailSender;
  private readonly feedbackAttachments?: AttachmentStore;

  constructor(deps: ConsoleAdminDeps) {
    this.userRepo = deps.userRepo;
    this.refreshTokenRepo = deps.refreshTokenRepo;
    this.planRepo = deps.planRepo;
    this.featureDefRepo = deps.featureDefRepo;
    this.personalSubscriptionRepo = deps.personalSubscriptionRepo;
    this.auditRepo = deps.auditRepo;
    this.orderRepo = deps.orderRepo;
    this.invoiceRepo = deps.invoiceRepo;
    this.auditWriter = deps.auditWriter;
    this.syncStateRepo = deps.syncStateRepo;
    this.syncRecordService = deps.syncRecordService;
    this.rateLimiter = deps.rateLimiter;
    this.feedbackRepo = deps.feedbackRepo;
    this.telemetryRepo = deps.telemetryRepo;
    this.emailSender = deps.emailSender;
    this.feedbackAttachments = deps.feedbackAttachments;
  }

  // ── 用户 ──

  /**
   * 受限读审计按 5min 窗口聚合：同一管理员、同一读类型在窗口内只落一条审计，
   * 防止高频受限读刷爆审计表。未注入 rateLimiter 时退化为逐请求写（测试装配）。
   */
  private async auditRestrictedRead(
    actorUserId: number,
    eventType: 'admin.users.read' | 'admin.audit.read' | 'admin.orders.read' | 'admin.invoices.read' | 'admin.plans.read' | 'admin.feedback.read' | 'admin.overview.read',
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
    const { cursor: _cursor, limit: _limit, ...countInput } = input;
    void _cursor; void _limit;
    const total = input.cursor === undefined ? await this.userRepo.countUsers(countInput) : undefined;
    await this.auditRestrictedRead(actorUserId, 'admin.users.read');
    return { items, nextId: hasMore ? items[items.length - 1].userId : null, total };
  }

  /**
   * P6：后台按类型密文元数据（只读）。**仅统计条数/字节/最近更新时间**，绝不返回
   * 密文或明文；受限读审计复用 `admin.users.read`（用户级读）。
   */
  async getSyncKindOverview(actorUserId: number, targetUserId: number): Promise<SyncKindOverviewRow[]> {
    const user = await this.userRepo.findById(targetUserId);
    if (!user) throw new EntityNotFoundError('user', targetUserId);
    const state = await this.syncStateRepo.findByUserId(targetUserId);
    const rows = state ? await this.syncRecordService.overviewByKind(targetUserId, state.keyEpoch) : [];
    await this.auditRestrictedRead(actorUserId, 'admin.users.read');
    return rows;
  }

  /**
   * 后台受限读：同步记录元数据明细（active only，id 倒序 keyset 分页）。
   * 绝不返回密文/nonce/tag；无同步态（用户从未启用同步）返回 null 状态与空列表。
   * 受限读审计复用 `admin.users.read`（用户级读，同 sync-overview）。
   */
  async getSyncRecords(actorUserId: number, targetUserId: number, opts: { kind?: string; afterId?: number; limit: number }): Promise<{
    state: { keyEpoch: string; stateVersion: string; changeSequence: string; protocolVersion: number; cipherSuite: string; formatVersion: number } | null;
    items: SyncRecordMetadataRow[];
    nextId: number | null;
  }> {
    const user = await this.userRepo.findById(targetUserId);
    if (!user) throw new EntityNotFoundError('user', targetUserId);
    const state = await this.syncStateRepo.findByUserId(targetUserId);
    const rows = state
      ? await this.syncRecordService.listMetadataByKind(targetUserId, state.keyEpoch, opts)
      : { items: [], nextId: null };
    await this.auditRestrictedRead(actorUserId, 'admin.users.read');
    return {
      state: state ? {
        keyEpoch: state.keyEpoch,
        stateVersion: state.stateVersion,
        changeSequence: state.changeSequence,
        protocolVersion: state.protocolVersion,
        cipherSuite: state.cipherSuite,
        formatVersion: state.formatVersion,
      } : null,
      items: rows.items,
      nextId: rows.nextId,
    };
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
   * 兜底档（free）不可归档——否则权益派生 fail-closed 会让全站读路径 500。
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
    const seen = new Set<string>();
    for (const f of input.features) {
      if (seen.has(f.featureKey)) throw new ValidationError(`duplicate feature: ${f.featureKey}`);
      seen.add(f.featureKey);
      const def = await this.featureDefRepo.findByKey(f.featureKey);
      if (!def) throw new ValidationError(`unknown feature: ${f.featureKey}`);
      if (def.kind !== 'both' && def.kind !== plan.kind) {
        throw new ValidationError(`feature ${f.featureKey} does not apply to ${plan.kind} plans`);
      }
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
    if (!['personal', 'both'].includes(input.kind)) throw new ValidationError('invalid feature kind');
    if (!['bool', 'number', 'bytes', 'stringList', 'enum'].includes(input.valueType)) throw new ValidationError('invalid value type');
    if (!Number.isInteger(input.sortOrder)) throw new ValidationError('invalid sort order');
    if (!input.label?.en || !input.label?.zh) throw new ValidationError('label requires en and zh');
    const { reason, ...defInput } = input;
    await this.featureDefRepo.upsertInTx(tx, defInput);
    await this.auditWriter.writeInTx(tx, {
      eventType: 'admin.plan_feature_def.updated', result: 'success', actorUserId, actorRole: 'platform_admin',
      targetType: 'plan_feature_def', targetId: input.key, reason,
    });
    // 必须走事务连接回读：池连接看不到本事务未提交的 INSERT。
    const def = await this.featureDefRepo.findByKeyInTx(tx, input.key);
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

  /**
   * 管理员角色授予/撤销（后台可配置管理员）：防自锁（不可改自己的角色——撤销会把自己
   * 锁出后台）；审计 granted/revoked；幂等（角色相同直接返回）。
   */
  async setUserRoleInTx(
    tx: Queryable,
    actorUserId: number,
    targetUserId: number,
    role: 'user' | 'platform_admin',
    reason: string,
  ): Promise<{ userId: string; role: string }> {
    if (targetUserId === actorUserId) {
      throw new ForbiddenError('cannot change own role');
    }
    const user = await this.userRepo.lockById(tx, targetUserId);
    if (!user) throw new EntityNotFoundError('user', targetUserId);
    if (user.role === role) return { userId: String(user.id), role: user.role };
    await this.userRepo.setRole(user.id, role);
    await this.auditWriter.writeInTx(tx, {
      eventType: role === 'platform_admin' ? 'admin.role.granted' : 'admin.role.revoked',
      result: 'success',
      actorUserId,
      actorRole: 'platform_admin',
      targetType: 'user',
      targetId: String(user.id),
      reason,
    });
    return { userId: String(user.id), role };
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

  // ── 订单 ──

  async listOrders(actorUserId: number, input: {
    userId?: number;
    status?: Order['status'];
    channel?: Order['channel'];
    purpose?: Order['purpose'];
    planCode?: string;
    createdFrom?: Date;
    createdTo?: Date;
    cursor?: number;
    limit: number;
  }): Promise<Page<Order>> {
    const rows = await this.orderRepo.listAll({ ...input, limit: input.limit + 1 });
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const { cursor: _cursor, limit: _limit, ...countInput } = input;
    void _cursor; void _limit;
    const total = input.cursor === undefined && this.orderRepo.countAll
      ? await this.orderRepo.countAll(countInput)
      : undefined;
    await this.auditRestrictedRead(actorUserId, 'admin.orders.read');
    return { items, nextId: hasMore ? items[items.length - 1].id : null, total };
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
    // P9.1：加油包订单必须走 /api/admin/ai/topup-orders/:orderNo/refund——该路径会在同事务
    // 撤销 grants 额度；通用退款只改订单状态，会留下「订单已退款 + 额度仍活」的矛盾账。
    if (order.purpose === 'topup') {
      throw new OrderInvalidStateError('topup orders must be refunded via the AI topup refund endpoint');
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
    const { cursor: _cursor, limit: _limit, ...countInput } = input;
    void _cursor; void _limit;
    const total = input.cursor === undefined && this.invoiceRepo.countAll
      ? await this.invoiceRepo.countAll(countInput)
      : undefined;
    await this.auditRestrictedRead(actorUserId, 'admin.invoices.read');
    return { items, nextId: hasMore ? items[items.length - 1].id : null, total };
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

  // ── 反馈 / 概览 ──

  async listFeedback(actorUserId: number, input: Omit<FeedbackFilter, 'limit'> & { limit: number }) {
    await this.auditRestrictedRead(actorUserId, 'admin.feedback.read');
    return this.feedbackRepo.list(input);
  }

  async updateFeedbackInTx(
    tx: Queryable,
    actorUserId: number,
    id: number,
    status: 'new' | 'triaged' | 'done' | 'rejected',
    adminNote: string | null,
  ): Promise<boolean> {
    const ok = await this.feedbackRepo.updateStatusInTx(tx, id, status, adminNote);
    if (ok) {
      this.auditWriter.writeInTx(tx, {
        eventType: 'admin.feedback.updated',
        result: 'success',
        actorUserId,
        actorRole: 'platform_admin',
        targetType: 'feedback',
        targetId: String(id),
        reason: adminNote ?? status,
      });
    }
    return ok;
  }

  /** 读取反馈附件（管理后台，鉴权后调用）；按 feedbackId + attachmentId 限定范围。 */
  async getFeedbackAttachment(
    actorUserId: number,
    feedbackId: number,
    attachmentId: number,
  ): Promise<{ fileName: string; mime: string; data: Buffer }> {
    void actorUserId;
    const meta = await this.feedbackRepo.findAttachment(feedbackId, attachmentId);
    if (!meta) throw new EntityNotFoundError('feedback attachment', attachmentId);
    if (!this.feedbackAttachments) throw new Error('feedback attachment store is not configured');
    const data = await this.feedbackAttachments.read(meta.storageName);
    return { fileName: meta.fileName, mime: meta.mime, data };
  }

  async getFeedbackDetail(actorUserId: number, id: number): Promise<FeedbackDetail> {
    const detail = await this.feedbackRepo.findDetail(id);
    if (!detail) throw new EntityNotFoundError('feedback', id);
    await this.auditRestrictedRead(actorUserId, 'admin.feedback.read');
    return detail;
  }

  /**
   * 事务内写回复（幂等回执同事务）：锁反馈行 → 解析邮件目标 → 写回复 → new→triaged → 审计。
   * 邮件**不在此发送**：返回 `email` 交由路由在提交后、且非重放时发送。
   */
  async replyFeedbackInTx(
    tx: Queryable,
    actorUserId: number,
    id: number,
    body: string,
    emailTarget: FeedbackEmailTarget,
  ): Promise<{ replyId: number; emailStatus: FeedbackEmailStatus; email: { to: string; originalContent: string } | null }> {
    const text = body.trim();
    if (text.length === 0) throw new ValidationError('reply body is required');
    if (text.length > MAX_FEEDBACK_REPLY) throw new ValidationError(`reply body exceeds ${MAX_FEEDBACK_REPLY} characters`);

    const fb = await this.feedbackRepo.findForReplyInTx(tx, id);
    if (!fb) throw new EntityNotFoundError('feedback', id);

    let emailTo: string | null = null;
    if (emailTarget === 'account') {
      if (!fb.userEmail) throw new ValidationError('feedback is not linked to an account');
      emailTo = fb.userEmail;
    } else if (emailTarget === 'contact') {
      const contact = (fb.contact ?? '').trim();
      if (!EMAIL_PATTERN.test(contact)) throw new ValidationError('contact is not an email address');
      emailTo = contact;
    }
    const emailStatus: FeedbackEmailStatus = emailTo ? 'pending' : 'skipped';

    const replyId = await this.feedbackRepo.createReplyInTx(tx, {
      feedbackId: id,
      adminUserId: actorUserId,
      body: text,
      emailStatus,
      emailTo,
    });
    await this.feedbackRepo.markTriagedIfNewInTx(tx, id);
    await this.auditWriter.writeInTx(tx, {
      eventType: 'admin.feedback.replied',
      result: 'success',
      actorUserId,
      actorRole: 'platform_admin',
      targetType: 'feedback',
      targetId: String(id),
      // 审计不落回复正文与收件地址，只记投递方式。
      reason: `email:${emailTarget}`,
    });
    return { replyId, emailStatus, email: emailTo ? { to: emailTo, originalContent: fb.content } : null };
  }

  /** 提交后投递回复邮件；失败只记状态，不影响已提交的站内回复。 */
  async sendFeedbackReplyEmail(replyId: number, to: string, reply: string, originalContent: string): Promise<'sent' | 'failed'> {
    if (!this.emailSender) {
      await this.feedbackRepo.updateReplyEmail(replyId, 'failed', 'email sender not configured');
      return 'failed';
    }
    try {
      await this.emailSender.sendFeedbackReplyEmail({ to, reply: reply.trim(), originalContent });
      await this.feedbackRepo.updateReplyEmail(replyId, 'sent', null);
      return 'sent';
    } catch (err) {
      // 只记录错误类别，不落 SMTP 响应全文（可能含服务器细节）。
      const message = err instanceof Error ? err.name || 'Error' : 'Error';
      await this.feedbackRepo.updateReplyEmail(replyId, 'failed', `send failed: ${message}`).catch(() => undefined);
      return 'failed';
    }
  }

  async getOverview(actorUserId: number): Promise<AdminOverview> {
    await this.auditRestrictedRead(actorUserId, 'admin.overview.read');
    const [base, telemetry] = await Promise.all([
      this.feedbackRepo.overview(),
      this.telemetryRepo.overview(),
    ]);
    return { ...base, telemetry };
  }

  async queryAudit(actorUserId: number, input: AuditFilter): Promise<Page<AuditEvent>> {
    const span = this.resolveAuditSpan(input.fromTime, input.toTime);
    const filter: AuditFilter = { ...input, fromTime: span.fromTime, toTime: span.toTime };
    const rows = await this.auditRepo.search({ ...filter, limit: input.limit + 1 });
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const { cursor: _cursor, limit: _limit, ...countInput } = filter;
    void _cursor; void _limit;
    const total = input.cursor === undefined ? await this.auditRepo.count(countInput) : undefined;
    await this.auditRestrictedRead(actorUserId, 'admin.audit.read');
    return { items, nextId: hasMore ? items[items.length - 1].id : null, total };
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