import type {
  IUserRepo, IPlanRepo, ISubscriptionRepo, IRefreshTokenRepo, ISyncRepo,
  IDeviceRepo, IConnectionMetaRepo, ISyncEventRepo, IUsageEventRepo, IAdminAuditRepo,
  PlanEditableFields, AuditActor,
} from '../repository/interfaces.js';
import type {
  User, Plan, Subscription, SessionInfo, Device, DeviceEvent, ConnectionMeta, SyncEvent, UsageEvent,
  AdminAuditLog,
} from '../domain/entities.js';
import type { Role, PlanCode, UserStatus, SubStatus, SectionType } from '../domain/enums.js';
import { EntityNotFoundError, ValidationError } from '../domain/errors.js';

export type UserInfo = Omit<User, 'passwordHash'>;

export interface UpdateUserInput {
  role?: Role;
  planCode?: PlanCode;
  status?: UserStatus;
}

/** 用户列表行：脱敏用户 + 订阅摘要 */
export interface AdminUserRow extends UserInfo {
  subscription?: { planCode: PlanCode; status: SubStatus; periodEndTime: Date };
}

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
  usage: {
    devices: number;
    syncBytes: number;
    sections: SectionUsage[];
  };
}

/** 订阅明细行：订阅 + 所属用户邮箱 */
export interface AdminSubscriptionRow extends Subscription {
  email?: string;
}

/**
 * 管理员服务：RBAC admin 专用。管理后台 /admin 的数据装配层。
 * 只读查询 + 用户/会话管理；不直接拼 SQL，依赖 repo 接口。
 */
export class AdminService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly planRepo: IPlanRepo,
    private readonly subRepo: ISubscriptionRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly syncRepo: ISyncRepo,
    private readonly deviceRepo: IDeviceRepo,
    private readonly connectionMetaRepo: IConnectionMetaRepo,
    private readonly syncEventRepo: ISyncEventRepo,
    private readonly usageEventRepo: IUsageEventRepo,
    private readonly auditRepo: IAdminAuditRepo,
  ) {}

  /**
   * 用户列表 + 订阅摘要。
   *
   * 订阅**必须批量取**：原实现在循环里逐个 `findByUserId`，而 admin-ui 固定请求
   * `limit=500`（`paginationQuery` 的上界也正是 500），于是一次 `/admin/users`
   * 是 `countUsers` 1 + `listAll` 1 + 500 次串行单查 = 502 个往返，全程独占一条
   * 池连接。跨可用区 2ms RTT 即约 1 秒，10 个并发 admin 请求就能占满连接池。
   */
  async listUsers(limit: number, offset: number): Promise<AdminUserRow[]> {
    const users = await this.userRepo.listAll(limit, offset);
    if (users.length === 0) return [];

    const subs = await this.subRepo.findByUserIds(users.map((u) => u.id));
    const byUser = new Map(subs.map((s) => [s.userId, s]));

    return users.map((user) => {
      const sub = byUser.get(user.id);
      return {
        ...sanitize(user),
        subscription: sub
          ? { planCode: sub.planCode, status: sub.status, periodEndTime: sub.periodEndTime }
          : undefined,
      };
    });
  }

  async countUsers(): Promise<number> {
    return this.userRepo.count();
  }

  async getUserDetail(id: number): Promise<AdminUserDetail> {
    const user = await this.userRepo.findById(id);
    if (!user) throw new EntityNotFoundError('user', id);
    const plan = await this.planRepo.findByCode(user.planCode);
    if (!plan) throw new Error(`plan not found: ${user.planCode}`);
    const subscription = await this.subRepo.findByUserId(id);
    const sessions = await this.refreshTokenRepo.listActiveForUser(id, new Date());
    const sections = await this.syncRepo.listSections(id);
    const usage = {
      devices: sessions.length,
      syncBytes: sections.reduce((n, s) => n + Buffer.byteLength(s.encryptedData, 'utf8'), 0),
      sections: sections.map((s) => ({
        section: s.section,
        version: s.version,
        bytes: Buffer.byteLength(s.encryptedData, 'utf8'),
        updateTime: s.updateTime,
      })),
    };
    return { user: sanitize(user), plan, subscription, sessions, usage };
  }

  async listPlans(): Promise<Plan[]> {
    return this.planRepo.listAll();
  }

  async updatePlan(code: PlanCode, input: PlanEditableFields, actor: AuditActor): Promise<void> {
    const int = (n: number, label: string) => {
      if (!Number.isInteger(n) || n < 0) throw new ValidationError('invalid ' + label);
    };
    if (typeof input.name !== 'string' || !input.name.trim()) throw new ValidationError('invalid name');
    int(input.priceMonth, 'priceMonth');
    int(input.priceYear, 'priceYear');
    int(input.maxConnections, 'maxConnections');
    int(input.syncQuotaBytes, 'syncQuotaBytes');
    int(input.syncVersionRetention, 'syncVersionRetention');
    int(input.features, 'features');
    const plan = await this.planRepo.findByCode(code);
    if (!plan) throw new EntityNotFoundError('plan', code);
    const next = { ...input, name: input.name.trim() };
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
    await this.refreshTokenRepo.revoke(sessionId);
  }

  async listSubscriptions(): Promise<AdminSubscriptionRow[]> {
    const subs = await this.subRepo.listAll();
    const rows: AdminSubscriptionRow[] = [];
    for (const sub of subs) {
      const user = await this.userRepo.findById(sub.userId);
      rows.push({ ...sub, email: user?.email });
    }
    return rows;
  }

  async listDevices(userId: number): Promise<Device[]> {
    return this.deviceRepo.listByUser(userId);
  }

  async listDeviceEvents(userId: number, deviceId: string): Promise<DeviceEvent[]> {
    return this.deviceRepo.listEvents(userId, deviceId);
  }

  async listConnections(userId: number): Promise<ConnectionMeta[]> {
    return this.connectionMetaRepo.listByUser(userId);
  }

  async listSyncEvents(userId: number): Promise<SyncEvent[]> {
    return this.syncEventRepo.listByUser(userId, 200);
  }

  async listUsageEvents(userId: number): Promise<UsageEvent[]> {
    return this.usageEventRepo.listByUser(userId, 200);
  }

  /**
   * 改用户的 role / planCode / status（三者均可选，只改传了的）。
   *
   * 枚举校验不能只靠路由 schema：`UpdateUserInput` 的字段是 TS 联合类型，
   * 编译期约束在运行时不存在，而路由层此前是 `req.body as UpdateUserInput`
   * 纯断言。写入非法值的后果各不相同且都不好查：
   *  - `planCode` 任意字符串 → `users.plan_code` 无 FK 指向 `plans.code`
   *    → 孤儿套餐码 → 之后 `/api/me` 因 `plan not found` 抛裸 Error → 500
   *  - `status` 任意值 → login 的 `status !== 'active'` 会拒绝登录（软封号）
   *  - `role` 任意值 → requireRole 不匹配，等于降权
   * 这里做服务层兜底，schema 与它是双层防护而非重复。
   *
   * 另外两条是**不可逆操作防护**，它们不是"友好提示"级别的校验：
   *  1. 不能降级/禁用自己。恢复 admin 权限需要的正是 admin 权限，所以自我
   *     降级之后唯一的出路是直接连数据库改 `users.role` —— 生产库上手改行
   *     是最不该出现的运维动作，而触发它只需要在下拉框里点错一次。
   *  2. 不能降级/禁用最后一个还能登录的 admin。同样的死锁，只是跨账号发生：
   *     两个 admin 互相降级，第二次成功之后系统就再没有管理员了。
   * 自己的 planCode 不在防护范围内 —— 改错了还能改回来。
   */
  async updateUser(id: number, input: UpdateUserInput, actor: AuditActor): Promise<void> {
    if (input.role !== undefined && !VALID_ROLES.includes(input.role)) {
      throw new ValidationError(`invalid role: ${input.role}`);
    }
    if (input.planCode !== undefined && !VALID_PLAN_CODES.includes(input.planCode)) {
      throw new ValidationError(`invalid planCode: ${input.planCode}`);
    }
    if (input.status !== undefined && !VALID_USER_STATUSES.includes(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }

    const before = await this.userRepo.findById(id);
    if (!before) throw new EntityNotFoundError('user', id);

    // 只把「真的会改掉现状」的字段算作变更：原样写回 admin 不该被当成自我降级，
    // 后台的下拉框每次 change 都整体提交，幂等提交必须放过。
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
      { role: input.role, planCode: input.planCode, status: input.status },
      ['role', 'planCode', 'status'],
    );
    // 三个字段都与现状相同时 detail 为空 —— 不留空记录，避免审计表被
    // 后台的幂等提交灌满噪声。
    if (Object.keys(detail).length > 0) {
      await this.audit(actor, 'user.update', 'user', String(id), detail);
    }

    if (input.role) await this.userRepo.updateRole(id, input.role);
    if (input.planCode) await this.userRepo.updatePlan(id, input.planCode);
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

  /**
   * 给不经 AdminService 的管理操作留痕（手动续费走 PaymentService、
   * 限流阈值走 RateLimitConfig）。路由层直接调。
   */
  async recordAudit(
    actor: AuditActor,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.audit(actor, action, targetType, targetId, detail);
  }

  /**
   * 写一条留痕。**先写审计再执行操作**，写失败就让操作一起失败。
   *
   * 反过来（吞掉审计错误、照常执行）等于「审计表一坏，所有管理操作就变成
   * 无痕操作」，而且没有任何迹象。宁可拒绝服务：留痕写不进去时管理端短暂
   * 不可用是可感知、可修的，静默失去审计能力不是。
   *
   * 代价是可能留下「记了但没做成」的记录（业务操作随后失败）。这个方向的
   * 误差是安全的 —— 多出来的记录可以和实际状态对照后排除，缺失的记录无法恢复。
   */
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

/**
 * 取 `from → to` 差异，只保留真正变化的字段。
 *
 * 旧值是排查的关键：只记新值的话，「配额从多少改成多少」事后查不到，
 * 而这恰恰是审计要回答的问题。
 */
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

/** 套餐的可审计字段。刻意与 PlanEditableFields 对齐，新增字段时一并加进来 */
const PLAN_AUDIT_FIELDS = [
  'name', 'priceMonth', 'priceYear', 'maxConnections',
  'syncQuotaBytes', 'syncVersionRetention', 'features',
] as const;

/** 枚举白名单（enums.ts 的类型是编译期的，运行时需要显式的值列表） */
const VALID_ROLES: readonly Role[] = ['user', 'admin'];
const VALID_PLAN_CODES: readonly PlanCode[] = ['free', 'pro', 'team'];
const VALID_USER_STATUSES: readonly UserStatus[] = ['active', 'disabled'];

function sanitize(user: User): UserInfo {
  const { passwordHash, ...rest } = user;
  return rest;
}