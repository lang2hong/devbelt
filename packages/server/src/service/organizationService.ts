import type {
  IOrganizationRepo, IMembershipRepo, ISeatRepo, IOrganizationResourceRepo,
  IOrganizationAuditRepo, ISubscriptionRepo, IPlanRepo,
  OrganizationResourceInput, OrganizationResourceEditableFields,
} from '../repository/interfaces.js';
import type {
  Organization, Membership, OrganizationResource, OrganizationResourcePermission, OrganizationAuditLog,
} from '../domain/entities.js';
import type { MemberRole, ResourcePermission, ResourceType } from '../domain/enums.js';
import { EntityNotFoundError, ValidationError, ForbiddenError, AlreadyExistsError } from '../domain/errors.js';

/** team 组织创建时赠送的试用天数；到期后订阅降为 expired，回落 free。 */
const TEAM_TRIAL_DAYS = 14;

/**
 * 组织域服务：组织 / 成员 / 席位 / 共享资源 / 权限 / 组织审计。
 *
 * v2 核心：团队协作放在 organization 上。私有资源仍属 user；本服务只管 org 级
 * 共享资源与成员生命周期。席位约束（活跃成员数 ≤ 活跃席位数）在 addMember 时
 * 应用层强制。
 *
 * ## 授权模型
 *
 * - 写操作（成员/资源/权限/审计管理）→ **requireOrgAdmin**：调用方必须是该 org 的
 *   active admin 成员（owner 注册即 admin，故 owner 恒通过）。
 * - 读操作（org 详情/成员/资源列表）→ **requireMember**：active 成员即可。
 * - 创建组织 / 列自己的组织 不加守卫（创建者 / 自身）。
 *
 * 任何越权一律抛 ForbiddenError → 403。这是发布级安全边界：org 路由的 authScope
 * 只验「登录」，成员归属必须在这里兜住，否则任意用户可改任意 org。
 */
export class OrganizationService {
  constructor(
    private readonly orgRepo: IOrganizationRepo,
    private readonly membershipRepo: IMembershipRepo,
    private readonly seatRepo: ISeatRepo,
    private readonly resourceRepo: IOrganizationResourceRepo,
    private readonly auditRepo: IOrganizationAuditRepo,
    private readonly subRepo: ISubscriptionRepo,
    private readonly planRepo: IPlanRepo,
  ) {}

  /** 列出某用户所属（活跃成员关系指向的）组织 */
  async listMyOrganizations(userId: number): Promise<Organization[]> {
    const memberships = await this.membershipRepo.listByUser(userId);
    const orgs: Organization[] = [];
    for (const m of memberships) {
      if (m.status !== 'active') continue;
      const org = await this.orgRepo.findById(m.organizationId);
      if (org) orgs.push(org);
    }
    return orgs;
  }

  async getOrganization(organizationId: number, actorUserId: number): Promise<Organization> {
    const org = await this.orgRepo.findById(organizationId);
    if (!org) throw new EntityNotFoundError('organization', organizationId);
    await this.requireMember(organizationId, actorUserId);
    return org;
  }

  /**
   * 创建 team 组织：建 org + admin 成员 + team 订阅（14 天试用）+ included_seats 个席位。
   *
   * 席位是 addMember 的硬约束（活跃成员数 ≤ 活跃席位数）。若只建 org 不建订阅/席位，
   * owner 这第一个成员就把 activeMembers 顶到 1 而 activeSeats 仍是 0，之后任何
   * addMember 恒抛「no available seat」——team 组织建出来即不可用。因此建组织时
   * 即按 team 套餐的 included_seats 补齐初始席位，owner 占其一。
   *
   * 订阅走 `trialing` + `trialEndTime`（TEAM_TRIAL_DAYS 天）：试用期内 resolveEffectivePlans
   * 解出 team 套餐额度，试用到期后由 ensureActive/downgradeExpired 降为 expired，回落
   * free。**不得建 active 订阅**——那等于免费永久发放付费套餐（付费门禁旁路）。
   * 正式 team 订阅由支付 webhook / admin renew 建立（status=active + periodEndTime）。
   */
  async createOrganization(userId: number, name: string): Promise<{ organization: Organization; membership: Membership }> {
    if (!name || !name.trim()) throw new ValidationError('name is required');

    // A3: 每用户最多 1 个活跃 team 组织（防试用薅：脚本循环建 team org 无限薅 14 天试用）
    const memberships = await this.membershipRepo.listByUser(userId);
    for (const m of memberships) {
      if (m.status !== 'active') continue;
      const org = await this.orgRepo.findById(m.organizationId);
      if (org?.type === 'team') {
        const sub = await this.subRepo.findByOrganizationId(org.id);
        if (sub && (sub.status === 'active' || sub.status === 'trialing')) {
          throw new AlreadyExistsError('user already has an active team organization');
        }
      }
    }

    const org = await this.orgRepo.create({ name: name.trim(), type: 'team', ownerUserId: userId });
    const membership = await this.membershipRepo.create({ organizationId: org.id, userId, role: 'admin' });
    const teamPlan = await this.planRepo.findByCode('team');
    if (!teamPlan) throw new ValidationError('team plan is missing; run migrations before createOrganization');
    const now = new Date();
    const sub = await this.subRepo.upsert({
      organizationId: org.id, planId: teamPlan.id, status: 'trialing', provider: 'manual',
      periodStartTime: now, trialEndTime: new Date(now.getTime() + TEAM_TRIAL_DAYS * 86_400_000),
    });
    for (let i = 0; i < teamPlan.includedSeats; i++) {
      await this.seatRepo.create({ subscriptionId: sub.id, organizationId: org.id });
    }
    await this.audit(userId, org.id, 'organization.create', undefined, undefined, { name: org.name });
    return { organization: org, membership };
  }

  // ── 成员 ──

  async listMembers(organizationId: number, actorUserId: number): Promise<Membership[]> {
    await this.getOrganization(organizationId, actorUserId);
    return this.membershipRepo.listByOrganization(organizationId);
  }

  /** 加成员。席位约束：活跃成员数必须 ≤ 活跃席位数（personal org 恒有 1 席位） */
  async addMember(organizationId: number, userId: number, role: MemberRole, actorUserId: number): Promise<Membership> {
    await this.requireOrgAdmin(organizationId, actorUserId);
    const existing = await this.membershipRepo.findByOrgAndUser(organizationId, userId);
    if (existing) throw new ValidationError('user is already a member');
    const activeSeats = await this.seatRepo.countActiveByOrganization(organizationId);
    const activeMembers = await this.membershipRepo.countActiveByOrganization(organizationId);
    if (activeMembers >= activeSeats) throw new ValidationError('no available seat');
    // P1-6: orgMaxMembers 校验（0 = 无限）
    const sub = await this.subRepo.findByOrganizationId(organizationId);
    if (sub) {
      const plan = await this.planRepo.findById(sub.planId);
      if (plan && plan.orgMaxMembers > 0 && activeMembers >= plan.orgMaxMembers) {
        throw new ValidationError(`organization member limit reached (${plan.orgMaxMembers})`);
      }
    }
    const membership = await this.membershipRepo.create({ organizationId, userId, role });
    await this.audit(actorUserId, organizationId, 'member.add', 'membership', membership.id, { userId, role });
    return membership;
  }

  /** P1-6: 成员自退；owner 禁止自退（需先转让或解散） */
  async leaveOrganization(organizationId: number, userId: number): Promise<void> {
    const m = await this.getMembership(organizationId, userId);
    await this.ensureNotOwner(organizationId, userId);
    await this.membershipRepo.softDelete(m.id);
    await this.audit(userId, organizationId, 'member.leave', 'membership', m.id, {});
  }

  async updateMemberRole(organizationId: number, membershipId: number, role: MemberRole, actorUserId: number): Promise<void> {
    await this.requireOrgAdmin(organizationId, actorUserId);
    const m = await this.membershipRepo.findById(membershipId);
    if (!m || m.organizationId !== organizationId) throw new EntityNotFoundError('membership', membershipId);
    if (role !== 'admin') {
      await this.ensureNotOwner(organizationId, m.userId);
    }
    await this.membershipRepo.updateRole(membershipId, role);
    await this.audit(actorUserId, organizationId, 'member.update_role', 'membership', membershipId, { role });
  }

  async removeMember(organizationId: number, membershipId: number, actorUserId: number): Promise<void> {
    await this.requireOrgAdmin(organizationId, actorUserId);
    const m = await this.membershipRepo.findById(membershipId);
    if (!m || m.organizationId !== organizationId) throw new EntityNotFoundError('membership', membershipId);
    await this.ensureNotOwner(organizationId, m.userId);
    await this.membershipRepo.softDelete(membershipId);
    await this.audit(actorUserId, organizationId, 'member.remove', 'membership', membershipId, { userId: m.userId });
  }

  // ── 共享资源 ──

  /**
   * 列出组织内可见的共享资源。
   *
   * `access_scope='organization'` 的资源全体成员可见；`restricted` 资源只有
   * admin 或在 organization_resource_permissions 里被显式授权的成员可见。
   * 这是 restricted 语义在读取路径的落地点 —— 不在这里过滤，任意成员就能
   * 读到受限资源的密文载荷，grantPermission 的授权就形同虚设。
   */
  async listResources(organizationId: number, actorUserId: number, type?: ResourceType): Promise<OrganizationResource[]> {
    await this.getOrganization(organizationId, actorUserId);
    const membership = await this.getMembership(organizationId, actorUserId);
    const resources = await this.resourceRepo.listByOrganization(organizationId, type);
    if (membership.role === 'admin') return resources;
    const perms = await this.resourceRepo.listPermissionsForMembership(membership.id);
    const allowedResourceIds = new Set(perms.map((p) => p.resourceId));
    return resources.filter(
      (r) => r.accessScope === 'organization' || allowedResourceIds.has(r.id),
    );
  }

  async createResource(organizationId: number, actorUserId: number, input: Omit<OrganizationResourceInput, 'organizationId' | 'createdByUserId'>): Promise<OrganizationResource> {
    await this.requireOrgAdmin(organizationId, actorUserId);
    const resource = await this.resourceRepo.create({ ...input, organizationId, createdByUserId: actorUserId });
    await this.audit(actorUserId, organizationId, 'resource.create', input.resourceType, resource.id, { name: input.name });
    return resource;
  }

  async updateResource(organizationId: number, resourceId: number, actorUserId: number, fields: OrganizationResourceEditableFields): Promise<void> {
    await this.requireOrgAdmin(organizationId, actorUserId);
    const r = await this.resourceRepo.findById(resourceId);
    if (!r || r.organizationId !== organizationId) throw new EntityNotFoundError('resource', resourceId);
    await this.resourceRepo.update(resourceId, { ...fields, updatedByUserId: actorUserId });
    await this.audit(actorUserId, organizationId, 'resource.update', r.resourceType, resourceId, {});
  }

  async softDeleteResource(organizationId: number, resourceId: number, actorUserId: number): Promise<void> {
    await this.requireOrgAdmin(organizationId, actorUserId);
    const r = await this.resourceRepo.findById(resourceId);
    if (!r || r.organizationId !== organizationId) throw new EntityNotFoundError('resource', resourceId);
    await this.resourceRepo.softDelete(resourceId);
    await this.audit(actorUserId, organizationId, 'resource.delete', r.resourceType, resourceId, {});
  }

  // ── 权限 ──

  async grantPermission(organizationId: number, resourceId: number, membershipId: number, permission: ResourcePermission, actorUserId: number): Promise<OrganizationResourcePermission> {
    await this.requireOrgAdmin(organizationId, actorUserId);
    const r = await this.resourceRepo.findById(resourceId);
    if (!r || r.organizationId !== organizationId) throw new EntityNotFoundError('resource', resourceId);
    const m = await this.membershipRepo.findById(membershipId);
    if (!m || m.organizationId !== organizationId) throw new EntityNotFoundError('membership', membershipId);
    const granted = await this.resourceRepo.grantPermission(organizationId, resourceId, membershipId, permission);
    await this.audit(actorUserId, organizationId, 'resource.grant', r.resourceType, resourceId, { membershipId, permission });
    return granted;
  }

  /**
   * 列出某资源的授权。先确认资源存在且未软删（findById 过滤 delete_time），
   * 再校验调用方是该 org 成员 —— 否则软删资源的陈旧授权会泄漏给非成员。
   */
  async listPermissions(organizationId: number, resourceId: number, actorUserId: number): Promise<OrganizationResourcePermission[]> {
    await this.requireMember(organizationId, actorUserId);
    const r = await this.resourceRepo.findById(resourceId);
    if (!r || r.organizationId !== organizationId) throw new EntityNotFoundError('resource', resourceId);
    return this.resourceRepo.listPermissions(resourceId);
  }

  /** 撤销成员对 restricted 资源的权限 */
  async revokePermission(organizationId: number, resourceId: number, membershipId: number, actorUserId: number): Promise<void> {
    await this.requireOrgAdmin(organizationId, actorUserId);
    const r = await this.resourceRepo.findById(resourceId);
    if (!r || r.organizationId !== organizationId) throw new EntityNotFoundError('resource', resourceId);
    const m = await this.membershipRepo.findById(membershipId);
    if (!m || m.organizationId !== organizationId) throw new EntityNotFoundError('membership', membershipId);
    await this.resourceRepo.revokePermission(resourceId, membershipId);
    await this.audit(actorUserId, organizationId, 'resource.revoke', r.resourceType, resourceId, { membershipId });
  }

  // ── 审计 ──

  async listAudit(organizationId: number, actorUserId: number, limit: number, offset: number): Promise<OrganizationAuditLog[]> {
    await this.requireOrgAdmin(organizationId, actorUserId);
    return this.auditRepo.listByOrganization(organizationId, limit, offset);
  }

  // ── 授权守卫 ──

  /** 调用方必须是该 org 的活跃成员（任意角色） */
  private async requireMember(organizationId: number, userId: number): Promise<void> {
    await this.getMembership(organizationId, userId);
  }

  /** 取调用方的活跃成员关系（requireMember 的可返回值版本） */
  private async getMembership(organizationId: number, userId: number): Promise<Membership> {
    const m = await this.membershipRepo.findByOrgAndUser(organizationId, userId);
    if (!m || m.status !== 'active') throw new ForbiddenError('not a member of this organization');
    return m;
  }

  /** 调用方必须是该 org 的活跃 admin 成员（owner 注册即 admin） */
  private async requireOrgAdmin(organizationId: number, userId: number): Promise<void> {
    const m = await this.membershipRepo.findByOrgAndUser(organizationId, userId);
    if (!m || m.status !== 'active' || m.role !== 'admin') throw new ForbiddenError('organization admin required');
  }

  /**
   * 禁止移除/降级商业 Owner。
   *
   * `organizations.owner_user_id` 是商业 Owner 的唯一权威，membership 不表达
   * owner（见设计文档 §2）。若任意 admin 能把 owner 的 membership 移除或降级
   * 出 admin，组织就会失去 owner（指针悬空）或失去最后一个可自管理的 admin。
   * owner 转移需另立显式方法，不在成员管理范围内。
   */
  private async ensureNotOwner(organizationId: number, userId: number): Promise<void> {
    const org = await this.orgRepo.findById(organizationId);
    if (org && org.ownerUserId === userId) {
      throw new ValidationError('cannot remove or demote the organization owner');
    }
  }

  private async audit(
    actorUserId: number,
    organizationId: number,
    action: string,
    resourceType: string | undefined,
    resourceId: number | undefined,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.auditRepo.record({ organizationId, actorUserId, action, resourceType, resourceId, detail });
  }
}