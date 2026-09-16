import type {
  Organization,
  OrganizationPlan,
  OrganizationSubscription,
  OrganizationMembership,
  OrganizationInvitation,
  Folder,
  Resource,
} from "../../domain/entities.js";
import type {
  OrganizationRole,
  OrganizationMembershipStatus,
  OrganizationSubscriptionStatus,
  ResourceType,
} from "../../domain/enums.js";
import type { Queryable } from "../mysql/db.js";
import type {
  AdminOrgRow,
  AdminOrgFilter,
} from "./admin.js";

/** 仓储接口 · organization（自 interfaces.ts 按聚合拆分，纯类型移动）。 */

export interface IOrganizationPlanRepo {
  findByCode(code: string): Promise<OrganizationPlan | undefined>;
  findById(id: number): Promise<OrganizationPlan | undefined>;
  /** 在事务内锁定 plan 行（创建组织时防 plan 变更）。 */
  findByCodeForUpdate(exec: Queryable, code: string): Promise<OrganizationPlan | undefined>;
  /** 列出上架（active）套餐目录，供 /api/plans 展示。 */
  listActive(): Promise<OrganizationPlan[]>;
}

export interface IOrganizationRepo {
  findById(id: number): Promise<Organization | undefined>;
  /** 在事务内锁定组织行（成员变更/关闭的序列化点）。 */
  lockById(exec: Queryable, id: number): Promise<Organization | undefined>;
  create(exec: Queryable, input: { name: string }): Promise<Organization>;
  updateName(exec: Queryable, id: number, name: string): Promise<void>;
  close(exec: Queryable, id: number, closedTime: Date): Promise<void>;
  /** 平台组织列表（filter + keyset cursor，DESC by id），join 订阅/成员/邀请计数。 */
  listForAdmin(input: AdminOrgFilter): Promise<AdminOrgRow[]>;
  /** 平台组织命中计数。 */
  countForAdmin(input: Omit<AdminOrgFilter, 'cursor' | 'limit'>): Promise<number>;
}

export interface IOrganizationSubscriptionRepo {
  findByOrganizationId(organizationId: number): Promise<OrganizationSubscription | undefined>;
  /** 在事务内锁定订阅行（创建/接受/撤销邀请时取 seat_limit，§6.2）。 */
  findByOrganizationIdForUpdate(exec: Queryable, organizationId: number): Promise<OrganizationSubscription | undefined>;
  create(exec: Queryable, input: {
    organizationId: number;
    planId: number;
    seatLimit: number;
    status: OrganizationSubscriptionStatus;
    entitlementSnapshot: Record<string, unknown>;
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<OrganizationSubscription>;
  /** 乐观更新（§6.2）：`WHERE id=? AND version=expectedVersion`，version+1；返回是否命中。 */
  update(exec: Queryable, input: {
    id: number;
    planId: number;
    seatLimit: number;
    status: OrganizationSubscriptionStatus;
    entitlementSnapshot: Record<string, unknown>;
    periodEndTime: Date | null;
    expectedVersion: number;
  }): Promise<boolean>;
}

export interface MemberDto {
  membershipId: number;
  userId: number;
  displayName?: string;
  role: OrganizationRole;
  status: OrganizationMembershipStatus;
  joinedTime: Date | null;
}

export interface OrganizationSummary {
  organizationId: number;
  name: string;
  status: string;
  closedTime: Date | null;
  role: OrganizationRole;
}

export interface IMembershipRepo {
  create(exec: Queryable, input: {
    organizationId: number;
    userId: number;
    role: OrganizationRole;
    status: OrganizationMembershipStatus;
    invitedByUserId: number | null;
    joinedTime: Date | null;
    removedTime: Date | null;
  }): Promise<OrganizationMembership>;
  /** 成员目录（active + invited，不含 removed），join users 取 displayName。 */
  listByOrganization(organizationId: number): Promise<MemberDto[]>;
  /** 某用户的 active membership（含组织 id，用于列组织）。 */
  listActiveByUser(userId: number): Promise<OrganizationMembership[]>;
  /** 某用户 active membership 且组织 active 的摘要（单条 JOIN organizations，供列组织）。 */
  listActiveByUserWithOrg(userId: number): Promise<OrganizationSummary[]>;
  /** 普通读（授权中间件用，非锁）。 */
  findByOrgAndUser(organizationId: number, userId: number): Promise<OrganizationMembership | undefined>;
  /** 事务内锁定 membership 行（角色/移除/退出）。 */
  findByOrgAndUserForUpdate(exec: Queryable, organizationId: number, userId: number): Promise<OrganizationMembership | undefined>;
  /** 事务内锁定 membership 行（按 id）。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<OrganizationMembership | undefined>;
  updateRole(exec: Queryable, id: number, role: OrganizationRole): Promise<void>;
  /** 置 status=removed + removed_time（移除/退出时）。 */
  remove(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 关闭组织时把该组织全部 invited membership 置 removed。 */
  removeInvitedByOrganization(exec: Queryable, organizationId: number, now: Date): Promise<void>;
  /**
   * 写入/复用一个 invited membership（创建邀请时用）：不存在则建，已存在（removed /
   * invited）则改回 invited 并覆盖角色，写 invited_by、清 joined/removed。按
   * (organization_id,user_id) 唯一键 upsert。
   */
  upsertInvited(exec: Queryable, input: {
    organizationId: number;
    userId: number;
    role: OrganizationRole;
    invitedByUserId: number;
  }): Promise<OrganizationMembership>;
  /** 置 status=active + joined_time、清 removed_time（接受邀请时）。 */
  activate(exec: Queryable, id: number, now: Date): Promise<void>;
  /** active 成员数（容量计量，不含 invited）。 */
  countActive(exec: Queryable, organizationId: number): Promise<number>;
  /** 有效 invited 成员数（join invitations，排除过期/撤销/已接受；容量计量）。 */
  countValidInvited(exec: Queryable, organizationId: number, now: Date): Promise<number>;
  /** active admin 数（最后 active admin 保护）。 */
  countActiveAdmins(exec: Queryable, organizationId: number): Promise<number>;
}

export interface InvitationDto {
  invitationId: number;
  email: string;
  role: OrganizationRole;
  expiresTime: Date;
  invitedTime: Date;
}

export interface IOrganizationInvitationRepo {
  create(exec: Queryable, input: {
    organizationId: number;
    membershipId: number;
    email: string;
    tokenHash: string;
    expiresTime: Date;
  }): Promise<OrganizationInvitation>;
  /** 按 token hash 只读查找（accept 预检，不回锁，锁定交给后续步骤）。 */
  findByTokenHash(tokenHash: string): Promise<OrganizationInvitation | undefined>;
  /** 按 id 只读查找（revoke 预检，不回锁）。 */
  findById(id: number): Promise<OrganizationInvitation | undefined>;
  /** 事务内按 id 锁定 invitation 行（accept/revoke 的序列化点）。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<OrganizationInvitation | undefined>;
  /** 事务内按 token hash 锁定（唯一键）。 */
  findByTokenHashForUpdate(exec: Queryable, tokenHash: string): Promise<OrganizationInvitation | undefined>;
  /** 作废某 membership 既有的未终结 invitation（重新邀请前调用，保证同时最多一个有效 token）。 */
  revokeByMembership(exec: Queryable, membershipId: number, now: Date): Promise<void>;
  /** 撤销某组织全部未终结 invitation（关闭组织时调用）。 */
  revokeByOrganization(exec: Queryable, organizationId: number, now: Date): Promise<void>;
  /** 标记接受（写 accepted_time）。 */
  markAccepted(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 标记撤销（写 revoked_time）。 */
  markRevoked(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 列某组织有效邀请（未 accepted/revoked 且未过期），join membership 取角色。 */
  listActiveByOrganization(organizationId: number, now: Date): Promise<InvitationDto[]>;
  /** 该 membership 当前是否有有效（未过期/未撤销/未接受）邀请。 */
  hasValidInvitation(exec: Queryable, membershipId: number, now: Date): Promise<boolean>;
  /** 列出有「已过期且未终结」邀请的组织 id（过期清理的候选，只读）。 */
  findExpiredOrganizationIds(now: Date): Promise<number[]>;
  /**
   * 把某组织内「过期（expires_time<=now 且未 accepted/revoked）」的邀请置 revoked、
   * 对应 membership 置 removed。必须在调用方事务内（已锁组织+订阅）执行。幂等。
   */
  expireByOrganization(exec: Queryable, organizationId: number, now: Date): Promise<void>;
}

export interface FolderDto {
  folderId: number;
  name: string;
  parentId: number | null;
}

export interface ResourceSummaryDto {
  resourceId: number;
  resourceType: ResourceType;
  name: string;
  folderId: number | null;
  version: number;
  createdByMembershipId: number;
  updatedByMembershipId: number | null;
}

export interface IFolderRepo {
  create(exec: Queryable, input: { organizationId: number; parentId: number | null; name: string }): Promise<Folder>;
  /** 事务内按 (id, organization_id) 锁定目录行（org 作用域）。 */
  findByIdForUpdate(exec: Queryable, organizationId: number, id: number): Promise<Folder | undefined>;
  /** 组织内全部未删除目录（含 parent_id）。 */
  listActive(organizationId: number): Promise<Folder[]>;
  /** 未删除子目录数（删除非空判定）。 */
  countActiveChildren(exec: Queryable, organizationId: number, parentId: number): Promise<number>;
  /** 目录下未删除资源数（删除非空判定）。 */
  countActiveResources(exec: Queryable, organizationId: number, folderId: number): Promise<number>;
  updateName(exec: Queryable, id: number, name: string, organizationId: number): Promise<void>;
  updateParent(exec: Queryable, id: number, parentId: number | null, organizationId: number): Promise<void>;
  /** 软删：`WHERE id AND organization_id AND delete_time IS NULL`。 */
  softDelete(exec: Queryable, id: number, organizationId: number, now: Date): Promise<void>;
  /** 该目录在组织内的全部后代目录 id（含自身；环比检测）。 */
  collectDescendantIds(exec: Queryable, organizationId: number, folderId: number): Promise<number[]>;
}

export interface IResourceRepo {
  create(exec: Queryable, input: {
    organizationId: number;
    folderId: number | null;
    resourceType: ResourceType;
    name: string;
    content: Record<string, unknown>;
    version: number;
    createdByMembershipId: number;
  }): Promise<Resource>;
  /** 按 (id, organization_id) 只读查（org 作用域）。 */
  findById(organizationId: number, id: number): Promise<Resource | undefined>;
  /** 事务内按 (id, organization_id) 锁定资源行（org 作用域）。 */
  findByIdForUpdate(exec: Queryable, organizationId: number, id: number): Promise<Resource | undefined>;
  /** 组织内全部未删除资源（不含 content）。 */
  listActiveByOrganization(organizationId: number): Promise<ResourceSummaryDto[]>;
  /** 锁内读回未删除资源 content（app 侧按 canonical JSON 计量，§6.2）。 */
  listActiveContent(exec: Queryable, organizationId: number): Promise<Record<string, unknown>[]>;
  /** 乐观锁更新（§6.2）：`WHERE id AND organization_id AND version=? AND delete_time IS NULL`；返回受影响的 skipper。 */
  update(exec: Queryable, input: {
    id: number;
    organizationId: number;
    name: string;
    folderId: number | null;
    content: Record<string, unknown>;
    baseVersion: number;
    updatedByMembershipId: number;
  }): Promise<boolean>;
  /** 软删：`WHERE id AND organization_id AND delete_time IS NULL`，写 updated_by。 */
  softDelete(exec: Queryable, id: number, organizationId: number, now: Date, deletedByMembershipId: number): Promise<void>;
}
