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
} from '../domain/errors.js';
import type { OrganizationMembership } from '../domain/entities.js';
import type { OrganizationRole } from '../domain/enums.js';
import type {
  IUserRepo,
  IOrganizationRepo,
  IOrganizationPlanRepo,
  IOrganizationSubscriptionRepo,
  IMembershipRepo,
  IOrganizationInvitationRepo,
  InvitationDto,
} from '../repository/interfaces.js';
import type { TxRunner, Queryable } from '../repository/mysql/db.js';
import type { RateLimitService } from './rateLimitService.js';
import type { TokenService } from './tokenService.js';
import type { EmailSender } from './emailSender.js';
import { roleHasPermission } from '../authz/permissionCatalog.js';

const ORGANIZATION_FREE = 'organization_free';

// 限流阈值（实施规格 §4.5）：组织创建按用户每小时最多 10 次（已认证，不按 IP）。
const ORG_CREATE_WINDOW_S = 3600;
const ORG_CREATE_MAX = 10;

// 邀请 token 有效期 7 天（实施规格 §4.7）。
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

/**
 * 组织服务（切片 2 / 切片 3）。
 *
 * 成员变更（角色/移除/退出）与邀请（创建/接受/撤销/过期）在事务内
 * 「锁组织行 → 锁订阅 → 锁 membership → 锁 invitation」串行化，并在锁内做
 * 最后 active admin 保护与 seat 容量校验（§3/§4.3）。
 *
 * 邀请 token 复用身份切片的既有模式（§4.7）：事务内落库 → 提交后发信 →
 * 发送失败不回滚；重新邀请先作废旧 token，保证同时最多一个有效 token。
 */
export class OrganizationService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly organizationRepo: IOrganizationRepo,
    private readonly organizationPlanRepo: IOrganizationPlanRepo,
    private readonly organizationSubscriptionRepo: IOrganizationSubscriptionRepo,
    private readonly membershipRepo: IMembershipRepo,
    private readonly invitationRepo: IOrganizationInvitationRepo,
    private readonly rateLimiter: RateLimitService,
    private readonly tokenService: TokenService,
    private readonly emailSender: EmailSender,
    private readonly runner: TxRunner,
  ) {}

  /** 列出用户 active membership 且组织 active 的组织（含其角色）。 */
  async listOrganizations(userId: number): Promise<OrganizationDto[]> {
    return this.membershipRepo.listActiveByUserWithOrg(userId);
  }

  /** 创建组织：限流后单事务锁定 organization_free plan，创建 active 组织 + Free 订阅 + 首位 active admin（§4.2）。 */
  async createOrganization(userId: number, name: string): Promise<OrganizationDto> {
    const trimmed = name.trim();
    if (!trimmed || Array.from(trimmed).length > 100) throw new ValidationError('invalid organization name');

    // 每次尝试都计数（事务外、进入业务前），与 register 一致；仅按用户，不按 IP。
    await this.rateLimiter.hit(`org:create:user:${userId}`, ORG_CREATE_WINDOW_S, ORG_CREATE_MAX);

    const org = await this.runner(async (tx) => {
      const plan = await this.organizationPlanRepo.findByCodeForUpdate(tx, ORGANIZATION_FREE);
      if (!plan) throw new Error(`${ORGANIZATION_FREE} plan is missing; run migrations before create`);

      const created = await this.organizationRepo.create(tx, { name: trimmed });
      const now = new Date();
      await this.organizationSubscriptionRepo.create(tx, {
        organizationId: created.id,
        planId: plan.id,
        seatLimit: plan.includedSeats,
        status: 'active',
        entitlementSnapshot: {
          includedSeats: plan.includedSeats,
          maxSharedResources: plan.maxSharedResources,
          sharedStorageQuotaBytes: plan.sharedStorageQuotaBytes,
          allowedTemplateDatabaseTypes: plan.allowedTemplateDatabaseTypes,
        },
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
      return created;
    });

    return { organizationId: org.id, name: org.name, status: org.status, closedTime: org.closedTime, role: 'admin' };
  }

  async updateOrganization(organizationId: number, name: string): Promise<{ ok: true }> {
    const trimmed = name.trim();
    if (!trimmed || Array.from(trimmed).length > 100) throw new ValidationError('invalid organization name');
    await this.runner(async (tx) => {
      const org = await this.organizationRepo.lockById(tx, organizationId);
      if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
      await this.organizationRepo.updateName(tx, organizationId, trimmed);
    });
    return { ok: true };
  }

  /**
   * 关闭组织（§5）：单一事务内置 closed、写 closed_time、撤销全部有效 invitations 行，
   * 并把该组织全部 invited membership 置 removed（§4.3/§6.5 切片 3 清单）。
   * 已 active 的 membership 保留。不可撤销。
   */
  async closeOrganization(organizationId: number): Promise<{ ok: true }> {
    await this.runner(async (tx) => {
      const org = await this.organizationRepo.lockById(tx, organizationId);
      if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
      await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
      const now = new Date();
      await this.organizationRepo.close(tx, organizationId, now);
      // 锁序统一：organization → subscription → membership → invitation
      await this.membershipRepo.removeInvitedByOrganization(tx, organizationId, now);
      await this.invitationRepo.revokeByOrganization(tx, organizationId, now);
    });
    return { ok: true };
  }

  async listMembers(organizationId: number) {
    return this.membershipRepo.listByOrganization(organizationId);
  }

  /** 分配角色（member.role.assign，目标非自身，最后 admin 保护）。 */
  async assignRole(organizationId: number, membershipId: number, role: OrganizationRole, actorUserId: number): Promise<{ ok: true }> {
    await this.runner(async (tx) => {
      await this.organizationRepo.lockById(tx, organizationId);
      await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
      const membership = await this.requireMembershipInTx(tx, membershipId, organizationId);
      if (membership.userId === actorUserId) throw new ForbiddenError('cannot assign role to self');
      if (membership.role === 'admin' && role === 'member') {
        await this.ensureNotLastAdmin(tx, organizationId);
      }
      await this.membershipRepo.updateRole(tx, membershipId, role);
    });
    return { ok: true };
  }

  /** 移除成员（member.remove，目标非自身，最后 admin 保护）。 */
  async removeMember(organizationId: number, membershipId: number, actorUserId: number): Promise<{ ok: true }> {
    await this.runner(async (tx) => {
      await this.organizationRepo.lockById(tx, organizationId);
      await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
      const membership = await this.requireMembershipInTx(tx, membershipId, organizationId);
      if (membership.userId === actorUserId) throw new ForbiddenError('cannot remove self');
      if (membership.role === 'admin') await this.ensureNotLastAdmin(tx, organizationId);
      await this.membershipRepo.remove(tx, membershipId, new Date());
    });
    return { ok: true };
  }

  /** 退出组织（active member；退出者不是最后 active admin）。 */
  async leaveOrganization(organizationId: number, userId: number): Promise<{ ok: true }> {
    await this.runner(async (tx) => {
      await this.organizationRepo.lockById(tx, organizationId);
      await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
      const membership = await this.membershipRepo.findByOrgAndUserForUpdate(tx, organizationId, userId);
      if (!membership || membership.status !== 'active') throw new OrganizationNotFoundError();
      if (membership.role === 'admin') await this.ensureNotLastAdmin(tx, organizationId);
      await this.membershipRepo.remove(tx, membership.id, new Date());
    });
    return { ok: true };
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

  /** 创建邀请（member.invite；§4.3 前置条件 + 容量 + token 作废旧）。 */
  async inviteMember(
    organizationId: number,
    actorUserId: number,
    actorRole: OrganizationRole,
    emailRaw: string,
    role?: OrganizationRole,
  ): Promise<InvitationResultDto> {
    const email = normalizeEmail(emailRaw);
    const targetRole = role ?? 'member';
    if (targetRole === 'admin' && !roleHasPermission(actorRole, 'member.role.assign')) {
      throw new ForbiddenError('inviting as admin requires member.role.assign');
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.tokenService.hashToken(token);
    const expiresTime = new Date(Date.now() + INVITATION_TOKEN_TTL_MS);

    const outcome = await this.runner(async (tx) => {
      const now = new Date();
      const org = await this.organizationRepo.lockById(tx, organizationId);
      if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
      const subscription = await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
      if (!subscription || subscription.status !== 'active') throw new OrganizationNotFoundError();

      const target = await this.userRepo.findByEmail(email);
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

      // 重新邀请：作废旧 token，保证同时最多一个有效 token（§4.7）。
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
      return { invitationId: invitation.id, email, organizationName: org.name, targetDisplayName: target.displayName };
    });

    await this.emailSender.sendInvitationEmail({
      to: email,
      organizationName: outcome.organizationName,
      token,
      displayName: outcome.targetDisplayName,
      expiresTime,
    }).catch((err) => {
      console.warn('[org] invitation email failed', String(err));
    });

    return { invitationId: outcome.invitationId, email, role: targetRole, expiresTime };
  }

  /** 列有效邀请（member.invite；不含 token/hash）。 */
  async listInvitations(organizationId: number): Promise<InvitationDto[]> {
    return this.invitationRepo.listActiveByOrganization(organizationId, new Date());
  }

  /** 撤销邀请（member.invite）：invitation revoked，membership removed，释放容量。 */
  async revokeInvitation(organizationId: number, invitationId: number): Promise<{ ok: true }> {
    // 先非锁读拿 membership 归属，再按「组织 → 订阅 → membership → invitation」加锁。
    // 跨组织 / 不存在的 id 返回 404 NOT_FOUND（§5 反枚举，与跨组织 membershipId 一致），
    // 仅「本组织内但已 accepted/revoked」属 token 状态非法，保持 400 INVITATION_INVALID。
    const hint = await this.invitationRepo.findById(invitationId);
    if (!hint || hint.organizationId !== organizationId) throw new EntityNotFoundError('invitation', invitationId);

    await this.runner(async (tx) => {
      const now = new Date();
      const org = await this.organizationRepo.lockById(tx, organizationId);
      if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
      await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);

      const membership = await this.membershipRepo.findByIdForUpdate(tx, hint.membershipId);
      if (!membership || membership.organizationId !== organizationId) throw new EntityNotFoundError('membership', hint.membershipId);

      const inv = await this.invitationRepo.findByIdForUpdate(tx, invitationId);
      if (!inv || inv.organizationId !== organizationId) throw new EntityNotFoundError('invitation', invitationId);
      if (inv.acceptedTime || inv.revokedTime) throw new InvitationInvalidError();

      await this.invitationRepo.markRevoked(tx, inv.id, now);
      await this.membershipRepo.remove(tx, membership.id, now);
    });
    return { ok: true };
  }

  /** 接受邀请（authenticated；token 反查组织；邮箱匹配；单次消费）。 */
  async acceptInvitation(token: string, userId: number): Promise<{ organization: OrganizationDto }> {
    const tokenHash = this.tokenService.hashToken(token);

    // 先非锁读拿到组织归属，再按「组织 → 订阅 → membership → invitation」加锁。
    const hint = await this.invitationRepo.findByTokenHash(tokenHash);
    if (!hint) throw new InvitationInvalidError();

    return this.runner(async (tx) => {
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

      const user = await this.userRepo.findById(userId);
      if (!user || user.status !== 'active' || !user.emailVerifiedTime || user.email !== inv.email) {
        throw new InvitationInvalidError();
      }

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
  }

  /**
   * 过期清理（§4.3/§4.7）：由受控清理任务调用。按组织维度协调——对每个有
   * 「已过期且未终结」邀请的组织开一个事务，按「锁组织 → 锁订阅」后执行过期，
   * 与创建/接受/撤销同一锁顺序（§4.3），避免绕过组织锁与业务事务交错。
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