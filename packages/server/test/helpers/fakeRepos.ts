import type {
  IUserRepo,
  IPlanRepo,
  ISubscriptionRepo,
  IRefreshTokenRepo,
  ISyncRepo,
  IDeviceRepo,
  IConnectionMetaRepo,
  
  
  
  
  IAdminAuditRepo,
  AdminAuditInput,
  IWebhookEventRepo,
  
  
  
  
  ConnectionMetaInput,
  PlanEditableFields,
  IOrganizationRepo,
  IMembershipRepo,
  ISeatRepo,
  IOrderRepo,
  IOrganizationResourceRepo,
  IOrganizationAuditRepo,
  OrganizationInput,
  OrganizationEditableFields,
  MembershipInput,
  SeatInput,
  OrderInput,
  OrganizationResourceInput,
  OrganizationResourceEditableFields,
  OrganizationAuditInput,
  IRegistrationRepo,
  RegistrationAccountInput,
  RegistrationResult,
} from '../../src/repository/interfaces.js';
import type {
  AdminAuditLog,
  User,
  Plan,
  Subscription,
  RefreshToken,
  SyncSection,
  SyncSectionVersion,
  SyncVersionSummary,
  SessionInfo,
  Device,

  ConnectionMeta,


  Organization,
  Membership,
  Seat,
  Order,
  OrganizationResource,
  OrganizationResourcePermission,
  OrganizationAuditLog,
} from '../../src/domain/entities.js';
import type { PlanCode, Role, SubStatus, SectionType, UserStatus } from '../../src/domain/enums.js';
import type {
  MemberRole,
  MemberStatus,
  ResourceType,
  ResourcePermission,
} from '../../src/domain/enums.js';
import { EXPIRABLE_STATUSES } from '../../src/domain/enums.js';
import { ConflictError, VersionNotFoundError } from '../../src/domain/errors.js';



/**
 * 内存审计仓储。
 *
 * `failNext` 用来测「留痕写不进去时管理操作必须一起失败」—— 这条不变量
 * 没法用真实故障触发，只能注入。
 */
export function makePlan(code: PlanCode, over: Partial<Plan> = {}): Plan {
  const now = new Date();
  return {
    id: 0,
    code,
    name: code,
    priceMonth: 0,
    priceYear: 0,
    seatPriceMonth: undefined,
    seatPriceYear: undefined,
    includedSeats: 1,
    perSeatMaxDevices: 0,
    perUserMaxPrivateConnections: 0,
    perUserMaxOpenConnections: 0,
    perUserPrivateSyncQuotaBytes: 0,
    perUserSyncVersionRetention: 0,
    perUserHistoryRetentionCount: 0,
    orgMaxSharedConnections: 0,
    orgSharedSyncQuotaBytes: 0,
    orgMaxMembers: 0,
    features: 1,
    createTime: now,
    updateTime: now,
    ...over,
  };
}

export class FakeUserRepo implements IUserRepo {
  readonly users = new Map<number, User>();
  private seq = 0;

  async findById(id: number): Promise<User | undefined> { return this.users.get(id); }
  async findByEmail(email: string): Promise<User | undefined> {
    for (const u of this.users.values()) if (u.email === email) return u;
    return undefined;
  }
  async create(email: string, passwordHash: string, role: Role, displayName?: string): Promise<User> {
    const now = new Date();
    const user: User = { id: ++this.seq, email, passwordHash, displayName, role, status: 'active', createTime: now, updateTime: now };
    this.users.set(user.id, user);
    return user;
  }
  async updateLastLogin(id: number, time: Date): Promise<void> { const u = this.users.get(id); if (u) u.lastLoginTime = time; }
  async updateRole(id: number, role: Role): Promise<void> { const u = this.users.get(id); if (u) u.role = role; }
  async updatePassword(id: number, passwordHash: string): Promise<void> { const u = this.users.get(id); if (u) u.passwordHash = passwordHash; }
  async updateStatus(id: number, status: UserStatus): Promise<void> { const u = this.users.get(id); if (u) u.status = status; }
  async listAll(limit: number, offset: number): Promise<User[]> { return [...this.users.values()].slice(offset, offset + limit); }
  async count(): Promise<number> { return this.users.size; }
  async countAdmins(): Promise<number> { let n = 0; for (const u of this.users.values()) if (u.role === 'admin' && u.status === 'active') n += 1; return n; }
}

export class FakePlanRepo implements IPlanRepo {
  readonly plans = new Map<number, Plan>();
  private seq = 0;
  constructor(plans: Plan[] = []) { for (const p of plans) { const id = ++this.seq; this.plans.set(id, { ...p, id }); } }
  async findById(id: number): Promise<Plan | undefined> { return this.plans.get(id); }
  async findByCode(code: PlanCode): Promise<Plan | undefined> { for (const p of this.plans.values()) if (p.code === code) return p; return undefined; }
  async listAll(): Promise<Plan[]> { return [...this.plans.values()]; }
  async seed(plans: Array<Omit<Plan, 'createTime' | 'updateTime'>>): Promise<void> { const now = new Date(); for (const p of plans) { const id = ++this.seq; this.plans.set(id, { ...p, id, createTime: now, updateTime: now }); } }
  async update(code: PlanCode, fields: PlanEditableFields): Promise<void> { const p = await this.findByCode(code); if (p) Object.assign(p, fields); }
}

export class FakeSubscriptionRepo implements ISubscriptionRepo {
  readonly subs = new Map<number, Subscription>();
  private seq = 0;
  downgradeCalls = 0;
  expireOneCalls = 0;
  failNextUpsert = false;

  async findByOrganizationId(organizationId: number): Promise<Subscription | undefined> {
    for (const s of this.subs.values()) if (s.organizationId === organizationId) return s;
    return undefined;
  }
  async findByOrganizationIds(organizationIds: number[]): Promise<Subscription[]> {
    if (organizationIds.length === 0) return [];
    const wanted = new Set(organizationIds);
    return [...this.subs.values()].filter((s) => wanted.has(s.organizationId));
  }
  async upsert(sub: Omit<Subscription, 'id' | 'createTime' | 'updateTime'> & { id?: number }): Promise<Subscription> {
    if (this.failNextUpsert) { this.failNextUpsert = false; throw new Error('simulated upsert failure'); }
    const now = new Date();
    const existing = sub.id !== undefined ? this.subs.get(sub.id) : await this.findByOrganizationId(sub.organizationId);
    if (existing) { const merged: Subscription = { ...existing, ...sub, id: existing.id, updateTime: now }; this.subs.set(existing.id, merged); return merged; }
    const created: Subscription = { ...sub, id: ++this.seq, createTime: now, updateTime: now };
    this.subs.set(created.id, created);
    return created;
  }
  async listByStatus(status: SubStatus): Promise<Subscription[]> { return [...this.subs.values()].filter((s) => s.status === status); }
  async listAll(): Promise<Subscription[]> { return [...this.subs.values()]; }
  async expireOne(organizationId: number, now: Date): Promise<boolean> {
    this.expireOneCalls++;
    for (const s of this.subs.values()) {
      if (s.organizationId === organizationId && EXPIRABLE_STATUSES.includes(s.status)) {
        const expired = (s.periodEndTime != null && s.periodEndTime <= now)
          || (s.status === 'trialing' && s.trialEndTime != null && s.trialEndTime <= now);
        if (expired) { s.status = 'expired'; return true; }
      }
    }
    return false;
  }
  async downgradeExpired(now: Date): Promise<number> {
    this.downgradeCalls++;
    let n = 0;
    for (const s of this.subs.values()) {
      if (EXPIRABLE_STATUSES.includes(s.status)) {
        const expired = (s.periodEndTime != null && s.periodEndTime <= now)
          || (s.status === 'trialing' && s.trialEndTime != null && s.trialEndTime <= now);
        if (expired) { s.status = 'expired'; n++; }
      }
    }
    return n;
  }
}

export class FakeRefreshTokenRepo implements IRefreshTokenRepo {
  readonly tokens = new Map<number, RefreshToken>();
  private seq = 0;

  async create(token: Omit<RefreshToken, 'id' | 'createTime' | 'updateTime'>): Promise<RefreshToken> {
    const now = new Date();
    const created: RefreshToken = { ...token, id: ++this.seq, createTime: now, updateTime: now };
    this.tokens.set(created.id, created);
    return created;
  }

  async findByHash(hash: string): Promise<RefreshToken | undefined> {
    for (const t of this.tokens.values()) if (t.tokenHash === hash) return t;
    return undefined;
  }

  async findById(id: number): Promise<RefreshToken | undefined> {
    return this.tokens.get(id);
  }

  async revoke(id: number): Promise<void> {
    const t = this.tokens.get(id);
    if (t && !t.revokedTime) t.revokedTime = new Date();
  }

  /**
   * 原子消费，复刻真实现的 `UPDATE ... WHERE id = ? AND revoked_time IS NULL`
   * 与 affectedRows 语义。
   *
   * 判定与赋值之间**刻意不放任何 await** —— 真实现靠单条 SQL 的原子性保证只有
   * 一个赢家，这里靠 JS 的同步执行保证同一件事。如果这里插入 await，fake 就会
   * 比真实现更宽松，从而把并发缺陷盖住（本仓库在 FakeSyncRepo 上踩过反向的坑：
   * fake 比真实现更严格，同样会让缺陷不可见）。
   */
  async consume(id: number, now: Date): Promise<boolean> {
    const t = this.tokens.get(id);
    if (!t || t.revokedTime) return false;
    t.revokedTime = now;
    t.lastUsedTime = now;
    return true;
  }

  async revokeAllForUser(userId: number): Promise<void> {
    const now = new Date();
    for (const t of this.tokens.values()) {
      if (t.userId === userId && !t.revokedTime) t.revokedTime = now;
    }
  }

  async revokeByDevice(userId: number, deviceId: string): Promise<void> {
    const now = new Date();
    for (const t of this.tokens.values()) {
      if (t.userId === userId && t.deviceId === deviceId && !t.revokedTime) t.revokedTime = now;
    }
  }

  async listActiveForUser(userId: number, now: Date): Promise<SessionInfo[]> {
    return this.activeFor(userId, now).map((t) => ({
      id: t.id,
      deviceName: t.deviceName,
      ip: t.ip,
      createTime: t.createTime,
      lastUsedTime: t.lastUsedTime,
      current: false,
    }));
  }

  private activeFor(userId: number, now: Date): RefreshToken[] {
    return [...this.tokens.values()].filter(
      (t) => t.userId === userId && !t.revokedTime && t.expiresTime > now,
    );
  }
}

export class FakeSyncRepo implements ISyncRepo {
  private readonly current = new Map<string, SyncSection>();
  private readonly history = new Map<string, SyncSectionVersion[]>();
  private seq = 0;

  async getSection(userId: number, section: SectionType): Promise<SyncSection | undefined> {
    return this.current.get(key(userId, section));
  }

  async listSections(userId: number): Promise<SyncSection[]> {
    return [...this.current.values()].filter((s) => s.userId === userId);
  }

  async putSection(
    userId: number,
    section: SectionType,
    encryptedData: string,
    version: number,
  ): Promise<number> {
    const k = key(userId, section);
    const existing = this.current.get(k);
    this.current.set(k, {
      userId,
      section,
      encryptedData,
      version,
      createTime: existing?.createTime ?? new Date(),
      updateTime: new Date(),
    });
    return version;
  }

  /**
   * 精确复刻 MysqlSyncRepo.putSectionIfVersion 的三条分支。
   *
   * 这个假实现曾经比真实现**更严格**（只判 curVersion !== baseVersion 就返回
   * null），于是真实现里「落后一个版本被误判成功」的缺陷在单测里完全看不见 ——
   * 假实现替真实现把关，把洞盖住了。教训：fake 的语义必须与真实现逐分支对齐，
   * 宁可一起错也不能一边宽一边严。
   */
  async putSectionIfVersion(
    userId: number,
    section: SectionType,
    encryptedData: string,
    baseVersion: number,
  ): Promise<number | null> {
    const cur = this.current.get(key(userId, section));
    // 行存在：版本必须精确匹配
    if (cur) {
      if (cur.version !== baseVersion) return null;
      return this.putSection(userId, section, encryptedData, baseVersion + 1);
    }
    // 行不存在：首次写入只允许 base = 0
    if (baseVersion !== 0) return null;
    return this.putSection(userId, section, encryptedData, 1);
  }

  /**
   * 复刻 MysqlSyncRepo.pushSection：乐观锁 + 历史快照。
   * 真实现里两者在一个事务内；内存实现天然不会半途失败，此处只需保证
   * 「冲突时一个字都不写」和「dataBytes = 0 不记快照」这两条外部可见语义一致。
   */
  async pushSection(
    userId: number,
    section: SectionType,
    encryptedData: string,
    baseVersion: number,
    dataBytes: number,
  ): Promise<number | null> {
    const newVersion = await this.putSectionIfVersion(userId, section, encryptedData, baseVersion);
    if (newVersion === null) return null;
    if (dataBytes > 0) {
      await this.recordVersion(userId, section, newVersion, encryptedData, dataBytes);
    }
    return newVersion;
  }

  async recordVersion(
    userId: number,
    section: SectionType,
    version: number,
    encryptedData: string,
    dataBytes: number,
  ): Promise<void> {
    const k = key(userId, section);
    const list = this.history.get(k) ?? [];
    const now = new Date();
    // 唯一键 (user_id, section, version) + ON DUPLICATE KEY UPDATE：同版本覆盖而非追加。
    // 真实现从 INSERT 改成 upsert 后，这里也必须跟着改 —— 否则 fake 里会攒出
    // 重复版本行，把「历史表不该有重复版本」这条不变量在单测里遮住。
    const existing = list.find((v) => v.version === version);
    if (existing) {
      existing.encryptedData = encryptedData;
      existing.dataBytes = dataBytes;
      existing.updateTime = now;
      return;
    }
    list.push({
      id: ++this.seq,
      userId,
      section,
      version,
      encryptedData,
      dataBytes,
      createTime: now,
      updateTime: now,
    });
    this.history.set(k, list);
  }

  async listVersions(
    userId: number,
    section: SectionType,
    limit: number,
  ): Promise<SyncVersionSummary[]> {
    const list = this.history.get(key(userId, section)) ?? [];
    return [...list]
      .sort((a, b) => b.version - a.version)
      .slice(0, limit)
      .map((v) => ({ version: v.version, dataBytes: v.dataBytes, createTime: v.createTime }));
  }

  async getVersion(
    userId: number,
    section: SectionType,
    version: number,
  ): Promise<SyncSectionVersion | undefined> {
    return (this.history.get(key(userId, section)) ?? []).find((v) => v.version === version);
  }

  async pruneVersions(userId: number, section: SectionType, retention: number): Promise<void> {
    const k = key(userId, section);
    const list = this.history.get(k) ?? [];
    if (list.length <= retention) return;
    const kept = [...list].sort((a, b) => a.version - b.version).slice(list.length - retention);
    this.history.set(k, kept);
  }

  /**
   * 复刻 MysqlSyncRepo.rollback：走乐观锁 + 记新版本快照。
   *
   * 两处此前与真实现不一致的地方：
   *  - 真实现 rollback 会 recordVersion，fake 不记 —— 于是「回滚后历史里多一条」
   *    这个可观察行为在单测里看不见。
   *  - 真实现原本用无条件 upsert（丢写竞态），现已改乐观锁；fake 用 pushSection
   *    对齐。内存实现无并发，重试分支走不到，但语义一致。
   * 抛 VersionNotFoundError 而不是裸 Error：路由层按 code 映射 404。
   */
  async rollback(userId: number, section: SectionType, toVersion: number): Promise<number> {
    const target = await this.getVersion(userId, section, toVersion);
    if (!target) throw new VersionNotFoundError(userId, section, toVersion);
    const cur = this.current.get(key(userId, section));
    const base = cur ? cur.version : 0;
    const dataBytes = Buffer.byteLength(target.encryptedData, 'utf8');
    const next = await this.pushSection(userId, section, target.encryptedData, base, dataBytes);
    if (next === null) throw new ConflictError(base, toVersion);
    return next;
  }

  async sumBytes(userId: number): Promise<number> {
    let total = 0;
    for (const s of this.current.values()) {
      if (s.userId === userId) total += Buffer.byteLength(s.encryptedData, 'utf8');
    }
    return total;
  }

  /** 测试辅助：某节的历史版本号列表（升序） */
  historyVersions(userId: number, section: SectionType): number[] {
    return (this.history.get(key(userId, section)) ?? []).map((v) => v.version).sort((a, b) => a - b);
  }
}

export class FakeDeviceRepo implements IDeviceRepo {
  readonly devices = new Map<string, Device>();
  private seq = 0;

  async upsert(device: Omit<Device, 'id' | 'createTime' | 'updateTime'>): Promise<Device> {
    const k = `${device.userId}:${device.deviceId}`;
    const now = new Date();
    const existing = this.devices.get(k);
    let result: Device;
    if (existing) {
      result = { ...existing, ...device, id: existing.id, updateTime: now };
    } else {
      result = { ...device, id: ++this.seq, createTime: now, updateTime: now, revokedTime: new Date() };
    }
    this.devices.set(k, result);
    return result;
  }

  async listByUser(userId: number): Promise<Device[]> {
    return [...this.devices.values()].filter((d) => d.userId === userId);
  }

  async bind(userId: number, deviceId: string): Promise<void> {
    const d = this.devices.get(`${userId}:${deviceId}`);
    if (d) this.devices.set(`${userId}:${deviceId}`, { ...d, revokedTime: undefined });
  }

  async revoke(userId: number, deviceId: string): Promise<void> {
    const d = this.devices.get(`${userId}:${deviceId}`);
    if (d) this.devices.set(`${userId}:${deviceId}`, { ...d, revokedTime: new Date() });
  }

  async isBound(userId: number, deviceId: string): Promise<boolean> {
    const d = this.devices.get(`${userId}:${deviceId}`);
    return !!(d && d.revokedTime == null);
  }

  async countBound(userId: number): Promise<number> {
    return [...this.devices.values()].filter((d) => d.userId === userId && d.revokedTime == null).length;
  }
}

export class FakeConnectionMetaRepo implements IConnectionMetaRepo {
  readonly metas = new Map<string, ConnectionMeta>();
  private seq = 0;

  async replaceAll(userId: number, metas: ConnectionMetaInput[]): Promise<number> {
    const now = new Date();
    const seen = new Set(metas.map((m) => m.connId));
    for (const m of metas) {
      const k = `${userId}:${m.connId}`;
      const existing = this.metas.get(k);
      this.metas.set(k, {
        ...m, id: existing?.id ?? ++this.seq, userId, deleteTime: undefined,
        createTime: existing?.createTime ?? now, updateTime: now,
      });
    }
    for (const [k, m] of this.metas) {
      if (m.userId === userId && m.deleteTime == null && !seen.has(m.connId)) {
        this.metas.set(k, { ...m, deleteTime: now, updateTime: now });
      }
    }
    return this.countActive(userId);
  }

  async countActive(userId: number): Promise<number> {
    let n = 0;
    for (const m of this.metas.values()) if (m.userId === userId && m.deleteTime == null) n++;
    return n;
  }

  async listByUser(userId: number): Promise<ConnectionMeta[]> {
    return [...this.metas.values()].filter((m) => m.userId === userId && m.deleteTime == null);
  }
}

export class FakeAdminAuditRepo implements IAdminAuditRepo {
  readonly rows: AdminAuditLog[] = [];
  failNext = false;
  private seq = 0;

  async record(entry: AdminAuditInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated audit write failure');
    }
    this.rows.push({ ...entry, id: ++this.seq, createTime: new Date() });
  }

  async list(limit: number, offset: number): Promise<AdminAuditLog[]> {
    return [...this.rows].reverse().slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return this.rows.length;
  }
}

/**
 * 内存 webhook 去重仓储。
 *
 * 键与真实现一致地按 `(provider, eventKey)` 组合 —— 只用 eventKey 的话
 * 「跨支付商不去重」这条不变量就被遮住了。
 */
export class FakeWebhookEventRepo implements IWebhookEventRepo {
  readonly rows = new Map<string, Record<string, unknown> | undefined>();

  async record(provider: string, eventKey: string, detail?: Record<string, unknown>): Promise<boolean> {
    const k = `${provider}:${eventKey}`;
    if (this.rows.has(k)) return false;
    this.rows.set(k, detail);
    return true;
  }

  async forget(provider: string, eventKey: string): Promise<void> {
    this.rows.delete(`${provider}:${eventKey}`);
  }
}

function key(userId: number, section: SectionType): string {
  return `${userId}:${section}`;
}

// ── v2：组织 / 成员 / 席位 / 订单 / 资源 / 审计 内存假仓储 ─────────
//
// S3a 纯增量，为 S3b 的 service 层单测备好落点。语义必须与 mysql 实现逐分支
// 对齐（见文件顶部教训：fake 比真实现更宽或更严都会把缺陷盖住）：
// - 活跃判定 = status='active' && deleteTime == null
// - 软删除置 deleteTime；软删后不在 list/count 出现
// - 权限 UPSERT：同 (resourceId, membershipId) 覆盖 permission

export function makeOrganization(over: Partial<Organization> = {}): Organization {
  const now = new Date();
  return {
    id: 0,
    name: 'org',
    type: 'personal',
    ownerUserId: 1,
    status: 'active',
    createTime: now,
    updateTime: now,
    ...over,
  };
}

export class FakeOrganizationRepo implements IOrganizationRepo {
  readonly orgs = new Map<number, Organization>();
  private seq = 0;

  async findById(id: number): Promise<Organization | undefined> {
    const o = this.orgs.get(id);
    return o && o.deleteTime == null ? o : undefined;
  }

  async listByOwner(userId: number): Promise<Organization[]> {
    return [...this.orgs.values()].filter((o) => o.ownerUserId === userId && o.deleteTime == null);
  }

  async create(input: OrganizationInput): Promise<Organization> {
    const now = new Date();
    const org: Organization = {
      id: ++this.seq,
      name: input.name,
      type: input.type,
      ownerUserId: input.ownerUserId,
      status: 'active',
      createTime: now,
      updateTime: now,
    };
    this.orgs.set(org.id, org);
    return org;
  }

  async update(id: number, fields: OrganizationEditableFields): Promise<void> {
    const o = this.orgs.get(id);
    if (o) {
      o.name = fields.name;
      o.status = fields.status;
      o.updateTime = new Date();
    }
  }

  async softDelete(id: number): Promise<void> {
    const o = this.orgs.get(id);
    if (o && o.deleteTime == null) o.deleteTime = new Date();
  }

  async listAll(limit: number, offset: number): Promise<Organization[]> {
    return [...this.orgs.values()].filter((o) => o.deleteTime == null).slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return [...this.orgs.values()].filter((o) => o.deleteTime == null).length;
  }
}

export class FakeMembershipRepo implements IMembershipRepo {
  readonly memberships = new Map<number, Membership>();
  private seq = 0;

  async findById(id: number): Promise<Membership | undefined> {
    const m = this.memberships.get(id);
    return m && m.deleteTime == null ? m : undefined;
  }

  async findByOrgAndUser(organizationId: number, userId: number): Promise<Membership | undefined> {
    return [...this.memberships.values()].find(
      (m) => m.organizationId === organizationId && m.userId === userId && m.deleteTime == null,
    );
  }

  async listByOrganization(organizationId: number): Promise<Membership[]> {
    return [...this.memberships.values()].filter(
      (m) => m.organizationId === organizationId && m.deleteTime == null,
    );
  }

  async listByUser(userId: number): Promise<Membership[]> {
    return [...this.memberships.values()].filter((m) => m.userId === userId && m.deleteTime == null);
  }

  async create(input: MembershipInput): Promise<Membership> {
    const now = new Date();
    const m: Membership = {
      id: ++this.seq,
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      status: 'active',
      createTime: now,
      updateTime: now,
    };
    this.memberships.set(m.id, m);
    return m;
  }

  async updateRole(id: number, role: MemberRole): Promise<void> {
    const m = this.memberships.get(id);
    if (m) {
      m.role = role;
      m.updateTime = new Date();
    }
  }

  async updateStatus(id: number, status: MemberStatus): Promise<void> {
    const m = this.memberships.get(id);
    if (m) {
      m.status = status;
      m.updateTime = new Date();
    }
  }

  async softDelete(id: number): Promise<void> {
    const m = this.memberships.get(id);
    if (m && m.deleteTime == null) m.deleteTime = new Date();
  }

  async countActiveByOrganization(organizationId: number): Promise<number> {
    return [...this.memberships.values()].filter(
      (m) => m.organizationId === organizationId && m.status === 'active' && m.deleteTime == null,
    ).length;
  }

  async countActiveByUser(userId: number): Promise<number> {
    return [...this.memberships.values()].filter(
      (m) => m.userId === userId && m.status === 'active' && m.deleteTime == null,
    ).length;
  }
}

export class FakeSeatRepo implements ISeatRepo {
  readonly seats = new Map<number, Seat>();
  private seq = 0;

  async findById(id: number): Promise<Seat | undefined> {
    const s = this.seats.get(id);
    return s && s.deleteTime == null ? s : undefined;
  }

  async listByOrganization(organizationId: number): Promise<Seat[]> {
    return [...this.seats.values()].filter((s) => s.organizationId === organizationId && s.deleteTime == null);
  }

  async countActiveByOrganization(organizationId: number): Promise<number> {
    return [...this.seats.values()].filter(
      (s) => s.organizationId === organizationId && s.status === 'active' && s.deleteTime == null,
    ).length;
  }

  async create(input: SeatInput): Promise<Seat> {
    const now = new Date();
    const seat: Seat = {
      id: ++this.seq,
      subscriptionId: input.subscriptionId,
      organizationId: input.organizationId,
      status: 'active',
      createTime: now,
      updateTime: now,
    };
    this.seats.set(seat.id, seat);
    return seat;
  }

  async revoke(id: number): Promise<void> {
    const s = this.seats.get(id);
    if (s) {
      s.status = 'revoked';
      s.updateTime = new Date();
    }
  }
}

export class FakeOrderRepo implements IOrderRepo {
  readonly orders = new Map<number, Order>();
  private seq = 0;

  async findById(id: number): Promise<Order | undefined> {
    return this.orders.get(id);
  }

  async create(input: OrderInput): Promise<Order> {
    const now = new Date();
    const order: Order = {
      id: ++this.seq,
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId,
      planId: input.planId,
      amount: input.amount,
      currency: input.currency,
      status: input.status,
      provider: input.provider,
      externalId: input.externalId,
      seatDelta: input.seatDelta,
      periodMonths: input.periodMonths,
      createTime: now,
      updateTime: now,
    };
    this.orders.set(order.id, order);
    return order;
  }

  async listByOrganization(organizationId: number, limit: number, offset: number): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => o.organizationId === organizationId)
      .sort((a, b) => b.id - a.id)
      .slice(offset, offset + limit);
  }

  async countByOrganization(organizationId: number): Promise<number> {
    return [...this.orders.values()].filter((o) => o.organizationId === organizationId).length;
  }
}

export class FakeOrganizationResourceRepo implements IOrganizationResourceRepo {
  readonly resources = new Map<number, OrganizationResource>();
  readonly permissions = new Map<number, OrganizationResourcePermission>();
  private seq = 0;
  private permSeq = 0;

  async findById(id: number): Promise<OrganizationResource | undefined> {
    const r = this.resources.get(id);
    return r && r.deleteTime == null ? r : undefined;
  }

  async listByOrganization(organizationId: number, type?: ResourceType): Promise<OrganizationResource[]> {
    return [...this.resources.values()].filter(
      (r) =>
        r.organizationId === organizationId &&
        r.deleteTime == null &&
        (type === undefined || r.resourceType === type),
    );
  }

  async create(input: OrganizationResourceInput): Promise<OrganizationResource> {
    const now = new Date();
    const r: OrganizationResource = {
      id: ++this.seq,
      organizationId: input.organizationId,
      resourceType: input.resourceType,
      name: input.name,
      accessScope: input.accessScope,
      encryptedData: input.encryptedData,
      createdByUserId: input.createdByUserId,
      createTime: now,
      updateTime: now,
    };
    this.resources.set(r.id, r);
    return r;
  }

  async update(id: number, fields: OrganizationResourceEditableFields): Promise<void> {
    const r = this.resources.get(id);
    if (!r) return;
    if (fields.name !== undefined) r.name = fields.name;
    if (fields.accessScope !== undefined) r.accessScope = fields.accessScope;
    if (fields.encryptedData !== undefined) r.encryptedData = fields.encryptedData;
    if (fields.updatedByUserId !== undefined) r.updatedByUserId = fields.updatedByUserId;
    r.updateTime = new Date();
  }

  async softDelete(id: number): Promise<void> {
    const r = this.resources.get(id);
    if (r && r.deleteTime == null) r.deleteTime = new Date();
  }

  async grantPermission(
    organizationId: number,
    resourceId: number,
    membershipId: number,
    permission: ResourcePermission,
  ): Promise<OrganizationResourcePermission> {
    const existing = await this.findPermission(resourceId, membershipId);
    if (existing) {
      existing.permission = permission;
      existing.updateTime = new Date();
      return existing;
    }
    const now = new Date();
    const p: OrganizationResourcePermission = {
      id: ++this.permSeq,
      organizationId,
      resourceId,
      membershipId,
      permission,
      createTime: now,
      updateTime: now,
    };
    this.permissions.set(p.id, p);
    return p;
  }

  async revokePermission(resourceId: number, membershipId: number): Promise<void> {
    for (const [id, p] of this.permissions) {
      if (p.resourceId === resourceId && p.membershipId === membershipId) this.permissions.delete(id);
    }
  }

  async listPermissions(resourceId: number): Promise<OrganizationResourcePermission[]> {
    return [...this.permissions.values()].filter((p) => p.resourceId === resourceId);
  }

  async listPermissionsForMembership(membershipId: number): Promise<OrganizationResourcePermission[]> {
    return [...this.permissions.values()].filter((p) => p.membershipId === membershipId);
  }

  async findPermission(resourceId: number, membershipId: number): Promise<OrganizationResourcePermission | undefined> {
    return [...this.permissions.values()].find(
      (p) => p.resourceId === resourceId && p.membershipId === membershipId,
    );
  }
}

/**
 * 内存组织审计假实现。`failNext` 复刻 IAdminAuditRepo 的不变量：
 * 留痕写不进去时管理操作必须一起失败 —— 这条没法用真实故障触发，只能注入。
 */
export class FakeOrganizationAuditRepo implements IOrganizationAuditRepo {
  readonly rows: OrganizationAuditLog[] = [];
  failNext = false;
  private seq = 0;

  async record(entry: OrganizationAuditInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated org audit write failure');
    }
    this.rows.push({ ...entry, id: ++this.seq, createTime: new Date() });
  }

  async listByOrganization(organizationId: number, limit: number, offset: number): Promise<OrganizationAuditLog[]> {
    return [...this.rows]
      .filter((r) => r.organizationId === organizationId)
      .reverse()
      .slice(offset, offset + limit);
  }

  async countByOrganization(organizationId: number): Promise<number> {
    return this.rows.filter((r) => r.organizationId === organizationId).length;
  }
}

/**
 * 内存注册假实现：把 user + personal org + membership + free 订阅 + 席位
 * 写进共享的 fake 上，使 resolvePlans(member → org → sub → plan) 能被解析。
 * free 套餐 id 从 planRepo 按 code 查询。
 */
export class FakeRegistrationRepo implements IRegistrationRepo {
  constructor(
    private readonly deps: {
      users: FakeUserRepo;
      orgs: FakeOrganizationRepo;
      memberships: FakeMembershipRepo;
      subs: FakeSubscriptionRepo;
      seats: FakeSeatRepo;
      plans: FakePlanRepo;
    },
  ) {}

  async createAccount(input: RegistrationAccountInput): Promise<RegistrationResult> {
    const exist = await this.deps.users.findByEmail(input.email);
    if (exist) throw new Error(`user already exists: ${input.email}`);
    const free = await this.deps.plans.findByCode('free');
    if (!free) throw new Error('free plan is missing');
    const user = await this.deps.users.create(input.email, input.passwordHash, input.role, input.displayName);
    const org = await this.deps.orgs.create({
      name: `${input.displayName ?? input.email}'s workspace`, type: 'personal', ownerUserId: user.id,
    });
    await this.deps.memberships.create({ organizationId: org.id, userId: user.id, role: 'admin' });
    const sub = await this.deps.subs.upsert({ organizationId: org.id, planId: free.id, status: 'active', provider: 'manual' });
    await this.deps.seats.create({ subscriptionId: sub.id, organizationId: org.id });
    return { userId: user.id, organizationId: org.id, subscriptionId: sub.id };
  }
}
