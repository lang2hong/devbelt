import type {
  IUserRepo, IPlanRepo, ISubscriptionRepo, IRefreshTokenRepo, ISyncRepo,
  IDeviceRepo, IConnectionMetaRepo, ISyncEventRepo, IUsageEventRepo,
  PlanEditableFields,
} from '../repository/interfaces.js';
import type {
  User, Plan, Subscription, SessionInfo, Device, DeviceEvent, ConnectionMeta, SyncEvent, UsageEvent,
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

  async updatePlan(code: PlanCode, input: PlanEditableFields): Promise<void> {
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
    await this.planRepo.update(code, { ...input, name: input.name.trim() });
  }

  async listSessions(userId: number): Promise<SessionInfo[]> {
    return this.refreshTokenRepo.listActiveForUser(userId, new Date());
  }

  async revokeSession(userId: number, sessionId: number): Promise<void> {
    const session = await this.refreshTokenRepo.findById(sessionId);
    if (!session || session.userId !== userId) throw new EntityNotFoundError('session', sessionId);
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
   */
  async updateUser(id: number, input: UpdateUserInput): Promise<void> {
    if (input.role !== undefined && !VALID_ROLES.includes(input.role)) {
      throw new ValidationError(`invalid role: ${input.role}`);
    }
    if (input.planCode !== undefined && !VALID_PLAN_CODES.includes(input.planCode)) {
      throw new ValidationError(`invalid planCode: ${input.planCode}`);
    }
    if (input.status !== undefined && !VALID_USER_STATUSES.includes(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }
    if (input.role) await this.userRepo.updateRole(id, input.role);
    if (input.planCode) await this.userRepo.updatePlan(id, input.planCode);
    if (input.status) await this.userRepo.updateStatus(id, input.status);
  }
}

/** 枚举白名单（enums.ts 的类型是编译期的，运行时需要显式的值列表） */
const VALID_ROLES: readonly Role[] = ['user', 'admin'];
const VALID_PLAN_CODES: readonly PlanCode[] = ['free', 'pro', 'team'];
const VALID_USER_STATUSES: readonly UserStatus[] = ['active', 'disabled'];

function sanitize(user: User): UserInfo {
  const { passwordHash, ...rest } = user;
  return rest;
}