import { randomBytes } from 'crypto';
import {
  ValidationError,
  ForbiddenError,
  EntityNotFoundError,
  OrganizationNotFoundError,
  OrganizationAdminRequiredError,
  InvitationInvalidError,
  InvitationTargetNotEligibleError,
  OrganizationQuotaExceededError,
} from '../../../domain/errors.js';
import type { OrganizationMembership } from '../../../domain/entities.js';
import type { OrganizationRole } from '../../../domain/enums.js';
import type {
  IUserRepo,
  IOrganizationRepo,
  IPlanRepo,
  IOrganizationSubscriptionRepo,
  IMembershipRepo,
  IOrganizationInvitationRepo,
  InvitationDto,
} from '../../../repository/interfaces.js';
import type { TxRunner, Queryable } from '../../../repository/mysql/db.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { EmailSender } from '../../auth/service/emailSender.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import { roleHasPermission, type PermissionCode } from '../../../authz/permissionCatalog.js';

const ORGANIZATION_FREE = 'organization_free';

// 限流阈值（实施规格 §5.2）：组织创建按用户每小时最多 10 次（已认证，不按 IP）。
const ORG_CREATE_WINDOW_S = 3600;
const ORG_CREATE_MAX = 10;

// 邀请 token 有效期 7 天。
const INVITATION_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

/** 组织 DTO（route 层再转 id -> string）。 */
export interface OrganizationDto {
  organizationId: number;
  name: string;
  status: string;
  closedTime: Date | null;
  role: OrganizationRole;
}

/** 邀请创建结果（route 层序列化 invitationId -> string）。 */
export interface InvitationResultDto {
  invitationId: number;
  email: string;
  role: OrganizationRole;
  expiresTime: Date;
}

/** 邀请事务内产出：额外携带发信所需信息（token 仅存内存，不入库、不入审计/回执）。 */
export interface InviteOutcome extends InvitationResultDto {
  organizationName: string;
  targetDisplayName?: string;
  token: string;
}

/**
 * 组织和邀请服务。
 *
 * 成员变更（角色/移除/退出）与邀请（创建/接受/撤销/过期）在事务内
 * 「锁组织行 → 锁订阅 → 锁 membership → 锁 invitation」串行化，并在锁内做
 * 最后 active admin 保护与 seat 容量校验（§6.1/§6.2）。
 *
 * 邀请 token 在事务内落库，提交后发信；发送失败不回滚；重新邀请先作废旧 token。
 *
 * 切片 3 幂等接线：每个写操作抽出 `XxxInTx` 事务内变体，供路由在
 * 幂等原语（receipt + 审计 + 业务同事务）内调用；公共方法保持「校验/限流 + runner」，
 * 供 extension 无 Idempotency-Key 的兼容路径使用。
 */
export class OrganizationService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly organizationRepo: IOrganizationRepo,
    private readonly planRepo: IPlanRepo,
    private readonly organizationSubscriptionRepo: IOrganizationSubscriptionRepo,
    private readonly membershipRepo: IMembershipRepo,
    private readonly invitationRepo: IOrganizationInvitationRepo,
    private readonly rateLimiter: RateLimitService,
    private readonly tokenService: TokenService,
    private readonly emailSender: EmailSender,
    private readonly runner: TxRunner,
    private readonly auditWriter?: AuditWriter,
  ) {}

  /** 列出用户 active membership 且组织 active 的组织（含其角色）。 */
  async listOrganizations(userId: number): Promise<OrganizationDto[]> {
    return this.membershipRepo.listActiveByUserWithOrg(userId);
  }

  /** 创建组织：限流后单事务（创建 active 组织 + Free 订阅 + 首位 active admin）。 */
  async createOrganization(userId: number, name: string): Promise<OrganizationDto> {
    await this.throttleCreateOrganization(userId);
    return this.runner((tx) => this.createOrganizationInTx(tx, userId, name));
  }

  /** 组织创建限流（连接池计数，供 extension 直连路径在事务外调用）。 */
  async throttleCreateOrganization(userId: number): Promise<void> {
    // 每次尝试都计数（事务外、进入业务前），与 register 一致；仅按用户，不按 IP。
    await this.rateLimiter.hit(`org:create:user:${userId}`, ORG_CREATE_WINDOW_S, ORG_CREATE_MAX);
  }

  /** 组织创建限流（同事务计数，供幂等路径在 createProcessing 之后、business 之前调用，随事务回滚）。 */
  async throttleCreateOrganizationInTx(tx: Queryable, userId: number): Promise<void> {
    await this.rateLimiter.hitInTx(tx, `org:create:user:${userId}`, ORG_CREATE_WINDOW_S, ORG_CREATE_MAX);
  }

  /** 创建组织的在事务内实现（不含限流）。 */
  async createOrganizationInTx(tx: Queryable, userId: number, name: string): Promise<OrganizationDto> {
    const trimmed = name.trim();
    if (!trimmed || Array.from(trimmed).length > 100) throw new ValidationError('invalid organization name');

    const plan = await this.planRepo.findByCodeInTx(tx, ORGANIZATION_FREE);
    if (!plan) throw new Error(`${ORGANIZATION_FREE} plan is missing; run migrations before create`);

    // seat_limit 是**订阅级强制值**：创建时取自套餐的 includedSeats 作为默认，
    // 之后管理端可独立调整且不受套餐约束（includedSeats 仅作目录/默认展示）。
    const includedSeats = Number(plan.features.includedSeats ?? 0);
    if (!Number.isInteger(includedSeats) || includedSeats < 1) {
      throw new Error(`${ORGANIZATION_FREE} plan has no valid includedSeats feature`);
    }

    const created = await this.organizationRepo.create(tx, { name: trimmed });
    const now = new Date();
    await this.organizationSubscriptionRepo.create(tx, {
      organizationId: created.id,
      planId: plan.id,
      seatLimit: includedSeats,
      status: 'active',
      periodStartTime: now,
      periodEndTime: null,
    });
    await this.membershipRepo.create(tx, {
      organizationId: created.id,
      userId,
      role: 'admin',
      status: 'active',
      invitedByUserId: null,
      joinedTime: now,
      removedTime: null,
    });
    return { organizationId: created.id, name: created.name, status: created.status, closedTime: created.closedTime, role: 'admin' };
  }

  async updateOrganization(organizationId: number, actorUserId: number, name: string): Promise<{ ok: true }> {
    return this.runner((tx) => this.updateOrganizationInTx(tx, organizationId, actorUserId, name));
  }

  async updateOrganizationInTx(tx: Queryable, organizationId: number, actorUserId: number, name: string): Promise<{ ok: true }> {
    const trimmed = name.trim();
    if (!trimmed || Array.from(trimmed).length > 100) throw new ValidationError('invalid organization name');
    const org = await this.organizationRepo.lockById(tx, organizationId);
    if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
    await this.requireActor(tx, organizationId, actorUserId, 'organization.update');
    await this.organizationRepo.updateName(tx, organizationId, trimmed);
    return { ok: true };
  }

  /**
   * 关闭组织（§6.1）：单一事务内写 status='closed' + closed_time、撤销全部有效 invitations 行，
   * 并把该组织全部 invited membership 置 removed。已 active 的 membership 保留。不可撤销。
   */
  async closeOrganization(organizationId: number, actorUserId: number): Promise<{ ok: true }> {
    return this.runner((tx) => this.closeOrganizationInTx(tx, organizationId, actorUserId));
  }

  async closeOrganizationInTx(tx: Queryable, organizationId: number, actorUserId: number): Promise<{ ok: true }> {
    const org = await this.organizationRepo.lockById(tx, organizationId);
    if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
    await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
    await this.requireActor(tx, organizationId, actorUserId, 'organization.close');
    const now = new Date();
    await this.organizationRepo.close(tx, organizationId, now);
    // 锁序统一：organization → subscription → membership → invitation
    await this.membershipRepo.removeInvitedByOrganization(tx, organizationId, now);
    await this.invitationRepo.revokeByOrganization(tx, organizationId, now);
    return { ok: true };
  }

  async listMembers(organizationId: number) {
    return this.membershipRepo.listByOrganization(organizationId);
  }

  /** 分配角色（member.role.assign，目标非自身，最后 admin 保护）。 */
  async assignRole(organizationId: number, membershipId: number, role: OrganizationRole, actorUserId: number): Promise<{ ok: true }> {
    return this.runner((tx) => this.assignRoleInTx(tx, organizationId, membershipId, role, actorUserId));
  }

  async assignRoleInTx(tx: Queryable, organizationId: number, membershipId: number, role: OrganizationRole, actorUserId: number): Promise<{ ok: true }> {
    await this.lockActiveOrganization(tx, organizationId);
    await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
    await this.requireActor(tx, organizationId, actorUserId, 'member.role.assign');
    const membership = await this.requireMembershipInTx(tx, membershipId, organizationId);
    if (membership.userId === actorUserId) throw new ForbiddenError('cannot assign role to self');
    if (membership.role === 'admin' && role === 'member') {
      await this.ensureNotLastAdmin(tx, organizationId);
    }
    await this.membershipRepo.updateRole(tx, membershipId, role);
    return { ok: true };
  }

  /** 移除成员（member.remove，目标非自身，最后 admin 保护）。 */
  async removeMember(organizationId: number, membershipId: number, actorUserId: number): Promise<{ ok: true }> {
    return this.runner((tx) => this.removeMemberInTx(tx, organizationId, membershipId, actorUserId));
  }

  async removeMemberInTx(tx: Queryable, organizationId: number, membershipId: number, actorUserId: number): Promise<{ ok: true }> {
    await this.lockActiveOrganization(tx, organizationId);
    await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
    await this.requireActor(tx, organizationId, actorUserId, 'member.remove');
    const membership = await this.requireMembershipInTx(tx, membershipId, organizationId);
    if (membership.userId === actorUserId) throw new ForbiddenError('cannot remove self');
    if (membership.role === 'admin') await this.ensureNotLastAdmin(tx, organizationId);
    await this.membershipRepo.remove(tx, membershipId, new Date());
    return { ok: true };
  }

  /** 退出组织（active member；退出者不是最后 active admin）。 */
  async leaveOrganization(organizationId: number, userId: number): Promise<{ ok: true }> {
    return this.runner((tx) => this.leaveOrganizationInTx(tx, organizationId, userId));
  }

  async leaveOrganizationInTx(tx: Queryable, organizationId: number, userId: number): Promise<{ ok: true }> {
    await this.lockActiveOrganization(tx, organizationId);
    await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
    const membership = await this.membershipRepo.findByOrgAndUserForUpdate(tx, organizationId, userId);
    if (!membership || membership.status !== 'active') throw new OrganizationNotFoundError();
    if (membership.role === 'admin') await this.ensureNotLastAdmin(tx, organizationId);
    await this.membershipRepo.remove(tx, membership.id, new Date());
    return { ok: true };
  }

  /** 锁定并要求组织仍 active（写事务的第一步，防「中间件放行后组织被并发关闭」）。 */
  private async lockActiveOrganization(tx: Queryable, organizationId: number): Promise<void> {
    const org = await this.organizationRepo.lockById(tx, organizationId);
    if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
  }

  /**
   * 事务内复核操作者授权（§6.1/§6.2）。
   *
   * organizationAuth 的角色判定发生在事务外：请求放行后，操作者可能被并发降级
   * 或移除，而写事务只锁了组织与目标行，仍会提交。这里在组织锁之后重新锁定
   * 操作者 membership 并重算权限码，使「授权 → 写入」落在同一串行化窗口内。
   *
   * 操作者已非 active membership 时按 §6.1 反枚举口径统一 404。
   */
  private async requireActor(
    tx: Queryable,
    organizationId: number,
    actorUserId: number,
    permission: PermissionCode,
  ): Promise<OrganizationMembership> {
    const actor = await this.membershipRepo.findByOrgAndUserForUpdate(tx, organizationId, actorUserId);
    if (!actor || actor.status !== 'active') throw new OrganizationNotFoundError();
    if (!roleHasPermission(actor.role, permission)) throw new ForbiddenError(`missing permission: ${permission}`);
    return actor;
  }

  private async requireMembershipInTx(tx: Queryable, membershipId: number, organizationId: number): Promise<OrganizationMembership> {
    const membership = await this.membershipRepo.findByIdForUpdate(tx, membershipId);
    if (!membership || membership.organizationId !== organizationId || membership.status !== 'active') {
      throw new EntityNotFoundError('membership', membershipId);
    }
    return membership;
  }

  private async ensureNotLastAdmin(tx: Queryable, organizationId: number): Promise<void> {
    const admins = await this.membershipRepo.countActiveAdmins(tx, organizationId);
    if (admins <= 1) throw new OrganizationAdminRequiredError();
  }

  /** 创建邀请（member.invite；§6.2 前置条件 + 容量 + token 作废旧）。提交后发信（事务外副作用）。 */
  async inviteMember(organizationId: number, actorUserId: number, emailRaw: string, role?: OrganizationRole): Promise<InvitationResultDto> {
    const outcome = await this.runner((tx) => this.inviteMemberInTx(tx, organizationId, actorUserId, emailRaw, role));
    await this.sendInvitation(outcome);
    return { invitationId: outcome.invitationId, email: outcome.email, role: outcome.role, expiresTime: outcome.expiresTime };
  }

  /**
   * 创建邀请的在事务内实现（member.invite；不含发信）。返回 production 供调用方
   * 在提交后（且非重放时）发信；token 仅存于 outcome 内存，不入库、不入审计/回执。
   */
  async inviteMemberInTx(tx: Queryable, organizationId: number, actorUserId: number, emailRaw: string, role?: OrganizationRole): Promise<InviteOutcome> {
    const email = normalizeEmail(emailRaw);
    const targetRole = role ?? 'member';

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.tokenService.hashToken(token);
    const expiresTime = new Date(Date.now() + INVITATION_TOKEN_TTL_MS);

    const now = new Date();
    const org = await this.organizationRepo.lockById(tx, organizationId);
    if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
    const subscription = await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
    if (!subscription || subscription.status !== 'active') throw new OrganizationNotFoundError();

    // 授权在锁内复核；提升为 admin 额外要求 member.role.assign（角色取锁内当前值）。
    const actor = await this.requireActor(tx, organizationId, actorUserId, 'member.invite');
    if (targetRole === 'admin' && !roleHasPermission(actor.role, 'member.role.assign')) {
      throw new ForbiddenError('inviting as admin requires member.role.assign');
    }

    // 走 InTx：事务中不得再向连接池申请第二条连接（会耗尽 connectionLimit 且
    // mysql2 无获取超时 → 永久死锁）。同时使该读落在本事务快照内。
    const target = await this.userRepo.findByEmailInTx(tx, email);
    if (!target || target.status !== 'active' || !target.emailVerifiedTime) {
      throw new InvitationTargetNotEligibleError();
    }

    const membership = await this.membershipRepo.findByOrgAndUserForUpdate(tx, organizationId, target.id);
    if (membership?.status === 'active') throw new InvitationTargetNotEligibleError('target is already a member');

    // 容量：有效占用（active + 有效 invited）+ 是否新增一个 seat。
    const used =
      (await this.membershipRepo.countActive(tx, organizationId)) +
      (await this.membershipRepo.countValidInvited(tx, organizationId, now));
    const holdsSeat = !!membership
      && membership.status === 'invited'
      && (await this.invitationRepo.hasValidInvitation(tx, membership.id, now));
    if (used + (holdsSeat ? 0 : 1) > subscription.seatLimit) throw new OrganizationQuotaExceededError();

    // 重新邀请：作废旧 token，保证同时最多一个有效 token。
    if (membership) await this.invitationRepo.revokeByMembership(tx, membership.id, now);

    const saved = await this.membershipRepo.upsertInvited(tx, {
      organizationId,
      userId: target.id,
      role: targetRole,
      invitedByUserId: actorUserId,
    });
    const invitation = await this.invitationRepo.create(tx, {
      organizationId,
      membershipId: saved.id,
      email,
      tokenHash,
      expiresTime,
    });

    return {
      invitationId: invitation.id,
      email,
      role: targetRole,
      expiresTime,
      organizationName: org.name,
      targetDisplayName: target.displayName,
      token,
    };
  }

  /** 邀请邮件发送（提交后副作用；失败仅记日志，不回滚）。 */
  async sendInvitation(outcome: InviteOutcome): Promise<void> {
    await this.emailSender.sendInvitationEmail({
      to: outcome.email,
      organizationName: outcome.organizationName,
      token: outcome.token,
      displayName: outcome.targetDisplayName,
      expiresTime: outcome.expiresTime,
    }).catch((err) => {
      console.warn('[org] invitation email failed', String(err));
    });
  }

  /** 列有效邀请（member.invite；不含 token/hash）。 */
  async listInvitations(organizationId: number): Promise<InvitationDto[]> {
    return this.invitationRepo.listActiveByOrganization(organizationId, new Date());
  }

  /** 撤销邀请的非锁定预读：拿 membership 归属，跨组织 / 不存在返回 404。 */
  async invitationMembershipId(invitationId: number, organizationId: number): Promise<number> {
    const hint = await this.invitationRepo.findById(invitationId);
    if (!hint || hint.organizationId !== organizationId) throw new EntityNotFoundError('invitation', invitationId);
    return hint.membershipId;
  }

  /** 撤销邀请（member.invite）：invitation revoked，membership removed，释放容量。 */
  async revokeInvitation(organizationId: number, actorUserId: number, invitationId: number): Promise<{ ok: true }> {
    // 先非锁读拿 membership 归属，再按「组织 → 订阅 → membership → invitation」加锁。
    const membershipId = await this.invitationMembershipId(invitationId, organizationId);
    return this.runner((tx) => this.revokeInvitationInTx(tx, organizationId, actorUserId, invitationId, membershipId));
  }

  /** 撤销邀请的在事务内实现。membershipId 需调用方经 `invitationMembershipId` 预读（跨组织 → 404）。 */
  async revokeInvitationInTx(tx: Queryable, organizationId: number, actorUserId: number, invitationId: number, membershipId: number): Promise<{ ok: true }> {
    const now = new Date();
    const org = await this.organizationRepo.lockById(tx, organizationId);
    if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
    await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
    await this.requireActor(tx, organizationId, actorUserId, 'member.invite');

    const membership = await this.membershipRepo.findByIdForUpdate(tx, membershipId);
    if (!membership || membership.organizationId !== organizationId) throw new EntityNotFoundError('membership', membershipId);

    const inv = await this.invitationRepo.findByIdForUpdate(tx, invitationId);
    if (!inv || inv.organizationId !== organizationId) throw new EntityNotFoundError('invitation', invitationId);
    if (inv.acceptedTime || inv.revokedTime) throw new InvitationInvalidError();

    await this.invitationRepo.markRevoked(tx, inv.id, now);
    await this.membershipRepo.remove(tx, membership.id, now);
    return { ok: true };
  }

  /** 接受邀请（authenticated；token 反查组织；邮箱匹配；单次消费）。 */
  async acceptInvitation(token: string, userId: number): Promise<{ organization: OrganizationDto }> {
    const tokenHash = this.tokenService.hashToken(token);

    // 先非锁读拿到组织归属，再按「组织 → 订阅 → membership → invitation」加锁。
    const hint = await this.invitationRepo.findByTokenHash(tokenHash);
    if (!hint) throw new InvitationInvalidError();

    const result = await this.runner(async (tx) => {
      const now = new Date();
      const org = await this.organizationRepo.lockById(tx, hint.organizationId);
      if (!org || org.status !== 'active') throw new InvitationInvalidError();
      const subscription = await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, org.id);
      if (!subscription || subscription.status !== 'active') throw new InvitationInvalidError();

      const membership = await this.membershipRepo.findByIdForUpdate(tx, hint.membershipId);
      if (!membership || membership.organizationId !== org.id || membership.status !== 'invited') {
        throw new InvitationInvalidError();
      }

      const inv = await this.invitationRepo.findByTokenHashForUpdate(tx, tokenHash);
      if (!inv || inv.acceptedTime || inv.revokedTime || inv.expiresTime <= now) throw new InvitationInvalidError();
      if (inv.organizationId !== org.id || inv.membershipId !== membership.id) throw new InvitationInvalidError();

      // 授权判据是 membership.userId === 调用者，**不是** email 字符串相等。
      const user = await this.userRepo.findByIdInTx(tx, userId);
      if (!user || user.status !== 'active' || !user.emailVerifiedTime) {
        throw new InvitationInvalidError();
      }
      if (membership.userId !== userId) throw new InvitationInvalidError();

      await this.invitationRepo.markAccepted(tx, inv.id, now);
      await this.membershipRepo.activate(tx, membership.id, now);

      return {
        organization: {
          organizationId: org.id,
          name: org.name,
          status: org.status,
          closedTime: org.closedTime,
          role: membership.role,
        },
      };
    });

    this.auditWriter?.write({
      eventType: 'invitation.accept',
      result: 'success',
      actorUserId: userId,
      targetType: 'organization',
      targetId: String(result.organization.organizationId),
      organizationId: result.organization.organizationId,
    });
    return result;
  }

  /**
   * 过期清理（§6.2）：由受控清理任务调用。按组织维度协调——对每个有
   * 「已过期且未终结」邀请的组织开一个事务，按「锁组织 → 锁订阅」后执行过期，
   * 与创建/接受/撤销同一锁顺序（§6.2），避免绕过组织锁与业务事务交错。
   * 单组织失败仅记录日志，不中断其余组织（幂等，下次周期重试）。
   */
  async expireInvitations(): Promise<void> {
    const orgIds = await this.invitationRepo.findExpiredOrganizationIds(new Date());
    for (const orgId of orgIds) {
      await this.runner(async (tx) => {
        await this.organizationRepo.lockById(tx, orgId);
        await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, orgId);
        await this.invitationRepo.expireByOrganization(tx, orgId, new Date());
      }).catch((err) => {
        console.warn('[invitation] expire failed', String(err));
      });
    }
  }
}

function normalizeEmail(emailRaw: string): string {
  const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
  if (!email || email.length > 255 || !email.includes('@')) {
    throw new ValidationError('invalid email');
  }
  return email;
}