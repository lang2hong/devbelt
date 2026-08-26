import type {
  IUserRepo, IPlanRepo, ISubscriptionRepo, IRefreshTokenRepo, ISyncRepo,
  IDeviceRepo, IConnectionMetaRepo, IAdminAuditRepo,
  IMembershipRepo, IOrganizationRepo,
  PlanEditableFields, AuditActor,
} from '../repository/interfaces.js';
import type {
  User, Plan, Subscription, SessionInfo, Device, ConnectionMeta,
  AdminAuditLog,
} from '../domain/entities.js';
import type { Role, UserStatus, SectionType } from '../domain/enums.js';
import { EntityNotFoundError, ValidationError } from '../domain/errors.js';
import type { PlanPolicy } from '../policy/planPolicy.js';
import { pickPrimaryPlan } from './planUtils.js';

export type UserInfo = Omit<User, 'passwordHash'>;

export interface UpdateUserInput {
  role?: Role;
  status?: UserStatus;
}

/** 用户列表行：脱敏用户（订阅改由 listSubscriptions 单独列出，不再按 user join） */
export type AdminUserRow = UserInfo;

/** 同步分节用量（端到端加密，仅密文字节维度可见） */
export interface SectionUsage {
  section: SectionType;
  version: number;
  bytes: number;
  updateTime: Date;
}

/** 用户详情：用户 + 套餐 + 订阅 + 会话 + 用量 */
export interface AdminUserDetail {
  user: UserInfo;
  plan: Plan;
  subscription?: Subscription;
  sessions: SessionInfo[];
  memberships: Array<{ organizationId: number; organizationName: string; role: string; status: string }>;
  usage: {
    devices: number;
    syncBytes: number;
    sections: SectionUsage[];
  };
}

/** 订阅明细行：订阅 + 所属组织名 */
export interface AdminSubscriptionRow extends Subscription {
  organizationName?: string;
}

/**
 * 管理员服务：RBAC admin 专用。管理后台 /admin 的数据装配层。
 * 只读查询 + 用户/会话管理；不直接拼 SQL，依赖 repo 接口。
 *
 * v2：用户套餐由有效席位套餐推导（PlanPolicy）；订阅与订单挂组织。
 */
export class AdminService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly planRepo: IPlanRepo,
    private readonly subRepo: ISubscriptionRepo,
    private readonly membershipRepo: IMembershipRepo,
    private readonly organizationRepo: IOrganizationRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly syncRepo: ISyncRepo,
    private readonly deviceRepo: IDeviceRepo,
    private readonly connectionMetaRepo: IConnectionMetaRepo,
    private readonly auditRepo: IAdminAuditRepo,
    private readonly planPolicy: PlanPolicy,
  ) {}

  async listUsers(limit: number, offset: number): Promise<AdminUserRow[]> {
    const users = await this.userRepo.listAll(limit, offset);
    return users.map(sanitize);
  }

  async countUsers(): Promise<number> {
    return this.userRepo.count();
  }

  async getUserDetail(id: number): Promise<AdminUserDetail> {
    const user = await this.userRepo.findById(id);
    if (!user) throw new EntityNotFoundError('user', id);
    const [effective] = [await this.planPolicy.effectivePlans(id)];
    const plan = pickPrimaryPlan(effective);
    const subscription = await this.personalSubscription(id);
    const sessions = await this.refreshTokenRepo.listActiveForUser(id, new Date());
    const sections = await this.syncRepo.listSections(id);
    // P3-19: 用户所属组织列表
    const rawMemberships = await this.membershipRepo.listByUser(id);
    const memberships = await Promise.all(
      rawMemberships.map(async (m) => {
        const org = await this.organizationRepo.findById(m.organizationId);
        return { organizationId: m.organizationId, organizationName: org?.name ?? '?', role: m.role, status: m.status };
      }),
    );
    const usage = {
      devices: await this.deviceRepo.countBound(id),
      syncBytes: sections.reduce((n, s) => n + Buffer.byteLength(s.encryptedData, 'utf8'), 0),
      sections: sections.map((s) => ({
        section: s.section,
        version: s.version,
        bytes: Buffer.byteLength(s.encryptedData, 'utf8'),
        updateTime: s.updateTime,
      })),
    };
    return { user: sanitize(user), plan, subscription, sessions, memberships, usage };
  }

  async listPlans(): Promise<Plan[]> {
    return this.planRepo.listAll();
  }

  async updatePlan(code: Plan['code'], input: PlanEditableFields, actor: AuditActor): Promise<void> {
    // 部分更新：只校验提供的字段。PlanEditableFields 类型上字段是必填，
    // 但路由 schema 把它们设为 optional，运行时分步 PATCH 会传 undefined。
    const int = (n: number | undefined, label: string) => {
      if (n === undefined) return;
      if (!Number.isFinite(n) || n < 0) throw new ValidationError('invalid ' + label);
    };
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new ValidationError('invalid name');
    int(input.priceMonth, 'priceMonth');
    int(input.priceYear, 'priceYear');
    int(input.includedSeats, 'includedSeats');
    int(input.perSeatMaxDevices, 'perSeatMaxDevices');
    int(input.perUserMaxPrivateConnections, 'perUserMaxPrivateConnections');
    int(input.perUserMaxOpenConnections, 'perUserMaxOpenConnections');
    int(input.perUserPrivateSyncQuotaBytes, 'perUserPrivateSyncQuotaBytes');
    int(input.perUserSyncVersionRetention, 'perUserSyncVersionRetention');
    int(input.perUserHistoryRetentionCount, 'perUserHistoryRetentionCount');
    int(input.orgMaxSharedConnections, 'orgMaxSharedConnections');
    int(input.orgSharedSyncQuotaBytes, 'orgSharedSyncQuotaBytes');
    int(input.orgMaxMembers, 'orgMaxMembers');
    int(input.features, 'features');
    const plan = await this.planRepo.findByCode(code);
    if (!plan) throw new EntityNotFoundError('plan', code);
    const next = { ...input, name: input.name !== undefined ? input.name.trim() : undefined } as PlanEditableFields;
    await this.audit(actor, 'plan.update', 'plan', code, diffFields(plan, next, PLAN_AUDIT_FIELDS));
    await this.planRepo.update(code, next);
  }

  async listSessions(userId: number): Promise<SessionInfo[]> {
    return this.refreshTokenRepo.listActiveForUser(userId, new Date());
  }

  async revokeSession(userId: number, sessionId: number, actor: AuditActor): Promise<void> {
    const session = await this.refreshTokenRepo.findById(sessionId);
    if (!session || session.userId !== userId) throw new EntityNotFoundError('session', sessionId);
    // detail 只放定位信息。session.tokenHash 是凭据材料，绝不进审计表
    await this.audit(actor, 'session.revoke', 'session', String(sessionId), {
      userId,
      deviceName: session.deviceName,
    });
    if (session.deviceId) {
      await this.deviceRepo.revoke(userId, session.deviceId);
      await this.refreshTokenRepo.revokeByDevice(userId, session.deviceId);
    } else {
      await this.refreshTokenRepo.revoke(sessionId);
    }
  }

  async listSubscriptions(): Promise<AdminSubscriptionRow[]> {
    const subs = await this.subRepo.listAll();
    const rows: AdminSubscriptionRow[] = [];
    for (const sub of subs) {
      const org = await this.organizationRepo.findById(sub.organizationId);
      rows.push({ ...sub, organizationName: org?.name });
    }
    return rows;
  }

  async listDevices(userId: number): Promise<Device[]> {
    return this.deviceRepo.listByUser(userId);
  }


  async listConnections(userId: number): Promise<ConnectionMeta[]> {
    return this.connectionMetaRepo.listByUser(userId);
  }



  /**
   * 改用户的 role / status / displayName（均可选，只改传了的）。
   *
   * 不可逆操作防护：不能降级/禁用自己；不能降级/禁用最后一个能登录的 admin。
   */
  async updateUser(id: number, input: UpdateUserInput, actor: AuditActor): Promise<void> {
    if (input.role !== undefined && !VALID_ROLES.includes(input.role)) {
      throw new ValidationError(`invalid role: ${input.role}`);
    }
    if (input.status !== undefined && !VALID_USER_STATUSES.includes(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }

    const before = await this.userRepo.findById(id);
    if (!before) throw new EntityNotFoundError('user', id);

    // 只把「真的会改掉现状」的字段算作变更：原样写回 admin 不该被当成自我降级
    const dropsRole = input.role !== undefined && input.role !== before.role && input.role !== 'admin';
    const dropsStatus = input.status !== undefined && input.status !== before.status && input.status !== 'active';

    if (id === actor.userId && dropsRole) {
      throw new ValidationError('cannot remove your own admin role; ask another admin to do it');
    }
    if (id === actor.userId && dropsStatus) {
      throw new ValidationError('cannot disable your own account');
    }
    // 目标当前是能登录的 admin，且这次改动会让它不能再管 → 检查是否仅存
    if (before.role === 'admin' && before.status === 'active' && (dropsRole || dropsStatus)) {
      if (await this.userRepo.countAdmins() <= 1) {
        throw new ValidationError('cannot demote or disable the last admin');
      }
    }

    const detail = diffFields(
      before,
      { role: input.role, status: input.status },
      ['role', 'status'],
    );
    if (Object.keys(detail).length > 0) {
      await this.audit(actor, 'user.update', 'user', String(id), detail);
    }

    if (input.role) await this.userRepo.updateRole(id, input.role);
    if (input.status) await this.userRepo.updateStatus(id, input.status);
  }

  /** 审计列表（管理后台的 Audit 页） */
  async listAudit(limit: number, offset: number): Promise<{ total: number; entries: AdminAuditLog[] }> {
    const [total, entries] = await Promise.all([
      this.auditRepo.count(),
      this.auditRepo.list(limit, offset),
    ]);
    return { total, entries };
  }

  async recordAudit(
    actor: AuditActor,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.audit(actor, action, targetType, targetId, detail);
  }

  /** P3-16: 检查 admin 是否是目标组织的成员（self-dealing 标记用） */
  async isMemberOf(organizationId: number, userId: number): Promise<boolean> {
    const m = await this.membershipRepo.findByOrgAndUser(organizationId, userId);
    return m?.status === 'active';
  }

  /** 取用户 personal org 的当前订阅（显示用） */
  private async personalSubscription(userId: number): Promise<Subscription | undefined> {
    const memberships = await this.membershipRepo.listByUser(userId);
    for (const m of memberships) {
      const org = await this.organizationRepo.findById(m.organizationId);
      if (org && org.type === 'personal') return this.subRepo.findByOrganizationId(org.id);
    }
    return undefined;
  }

  private async audit(
    actor: AuditActor,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const who = await this.userRepo.findById(actor.userId);
    try {
      await this.auditRepo.record({
        actorUserId: actor.userId,
        actorEmail: who?.email,
        action,
        targetType,
        targetId,
        detail,
        ip: actor.ip,
      });
    } catch (err) {
      throw new Error(
        `audit write failed, refusing to perform ${action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** 取 from → to 差异，只保留真正变化的字段 */
function diffFields<T extends Record<string, any>>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    const to = after[f];
    if (to === undefined) continue;
    if (before[f] === to) continue;
    out[f] = { from: before[f], to };
  }
  return out;
}

/** 套餐的可审计字段。刻意与 PlanEditableFields 对齐 */
const PLAN_AUDIT_FIELDS = [
  'name', 'priceMonth', 'priceYear', 'seatPriceMonth', 'seatPriceYear', 'includedSeats',
  'perSeatMaxDevices', 'perUserMaxPrivateConnections', 'perUserMaxOpenConnections',
  'perUserPrivateSyncQuotaBytes', 'perUserSyncVersionRetention', 'perUserHistoryRetentionCount',
  'orgMaxSharedConnections', 'orgSharedSyncQuotaBytes', 'orgMaxMembers', 'features',
] as const;

/** 枚举白名单（enums.ts 的类型是编译期的，运行时需要显式的值列表） */
const VALID_ROLES: readonly Role[] = ['user', 'admin'];
const VALID_USER_STATUSES: readonly UserStatus[] = ['active', 'disabled'];

function sanitize(user: User): UserInfo {
  const { passwordHash, ...rest } = user;
  return rest;
}