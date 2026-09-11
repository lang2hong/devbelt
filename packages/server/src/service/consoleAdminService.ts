import type {
  IUserRepo,
  IRefreshTokenRepo,
  IPersonalPlanRepo,
  IPersonalSubscriptionRepo,
  IOrganizationPlanRepo,
  IOrganizationRepo,
  IOrganizationSubscriptionRepo,
  IMembershipRepo,
  IAuditRepo,
  AdminUserRow,
  AdminOrgRow,
  AuditFilter,
} from '../repository/interfaces.js';
import type { Queryable } from '../repository/mysql/db.js';
import type { AuditEvent, PersonalPlan, OrganizationPlan } from '../domain/entities.js';
import type { UserStatus } from '../domain/enums.js';
import {
  EntityNotFoundError,
  ForbiddenError,
  SubscriptionVersionConflictError,
  ExportTooLargeError,
  ValidationError,
} from '../domain/errors.js';
import { AuditWriter } from './auditWriter.js';
import { auditDto, toCsv } from './auditSerialize.js';
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
  personalPlanRepo: IPersonalPlanRepo;
  personalSubscriptionRepo: IPersonalSubscriptionRepo;
  organizationPlanRepo: IOrganizationPlanRepo;
  organizationRepo: IOrganizationRepo;
  organizationSubscriptionRepo: IOrganizationSubscriptionRepo;
  membershipRepo: IMembershipRepo;
  auditRepo: IAuditRepo;
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
  private readonly personalPlanRepo: IPersonalPlanRepo;
  private readonly personalSubscriptionRepo: IPersonalSubscriptionRepo;
  private readonly organizationPlanRepo: IOrganizationPlanRepo;
  private readonly organizationRepo: IOrganizationRepo;
  private readonly organizationSubscriptionRepo: IOrganizationSubscriptionRepo;
  private readonly membershipRepo: IMembershipRepo;
  private readonly auditRepo: IAuditRepo;
  private readonly auditWriter: AuditWriter;
  private readonly rateLimiter?: RateLimitService;

  constructor(deps: ConsoleAdminDeps) {
    this.userRepo = deps.userRepo;
    this.refreshTokenRepo = deps.refreshTokenRepo;
    this.personalPlanRepo = deps.personalPlanRepo;
    this.personalSubscriptionRepo = deps.personalSubscriptionRepo;
    this.organizationPlanRepo = deps.organizationPlanRepo;
    this.organizationRepo = deps.organizationRepo;
    this.organizationSubscriptionRepo = deps.organizationSubscriptionRepo;
    this.membershipRepo = deps.membershipRepo;
    this.auditRepo = deps.auditRepo;
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
    eventType: 'admin.users.read' | 'admin.organizations.read' | 'admin.audit.read',
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

  async resolvePersonalPlanInTx(tx: Queryable, planCode: string): Promise<PersonalPlan> {
    const plan = await this.personalPlanRepo.findByCodeInTx(tx, planCode);
    if (!plan || plan.status !== 'active') throw new ValidationError('unknown or inactive plan');
    return plan;
  }

  /** 从个人 plan 构造冻结权益快照（与注册时口径一致）。 */
  personalEntitlementSnapshot(plan: PersonalPlan): Record<string, unknown> {
    return {
      allowedDatabaseTypes: plan.allowedDatabaseTypes,
      maxDevices: plan.maxDevices,
      maxConnectionMetas: plan.maxConnectionMetas,
      syncStorageBytes: plan.syncStorageBytes,
      maxSavedConnections: plan.maxSavedConnections,
      allowConnectionImport: plan.allowConnectionImport,
    };
  }

  async resolveOrganizationPlanInTx(tx: Queryable, planCode: string): Promise<OrganizationPlan> {
    const plan = await this.organizationPlanRepo.findByCodeForUpdate(tx, planCode);
    if (!plan || plan.status !== 'active') throw new ValidationError('unknown or inactive plan');
    return plan;
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
      snapshot: Record<string, unknown>;
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
      entitlementSnapshot: params.snapshot,
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

  async adjustOrganizationSubscriptionInTx(
    tx: Queryable,
    actorUserId: number,
    organizationId: number,
    params: {
      planId: number;
      seatLimit: number;
      snapshot: Record<string, unknown>;
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
      entitlementSnapshot: params.snapshot,
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