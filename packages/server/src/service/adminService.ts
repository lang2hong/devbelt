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

  async listUsers(limit: number, offset: number): Promise<AdminUserRow[]> {
    const users = await this.userRepo.listAll(limit, offset);
    const rows: AdminUserRow[] = [];
    for (const user of users) {
      const safe = sanitize(user);
      const sub = await this.subRepo.findByUserId(user.id);
      rows.push({
        ...safe,
        subscription: sub
          ? { planCode: sub.planCode, status: sub.status, periodEndTime: sub.periodEndTime }
          : undefined,
      });
    }
    return rows;
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

  async updateUser(id: number, input: UpdateUserInput): Promise<void> {
    if (input.role) await this.userRepo.updateRole(id, input.role);
    if (input.planCode) await this.userRepo.updatePlan(id, input.planCode);
    if (input.status) await this.userRepo.updateStatus(id, input.status);
  }
}

function sanitize(user: User): UserInfo {
  const { passwordHash, ...rest } = user;
  return rest;
}