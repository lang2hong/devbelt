import type {
  IUserRepo,
  IEmailVerificationTokenRepo,
  IPersonalPlanRepo,
  IPersonalSubscriptionRepo,
  IDeviceRepo,
  IRefreshTokenRepo,
  IRateLimitRepo,
  IRegistrationRepo,
  IOrganizationPlanRepo,
  IOrganizationRepo,
  IOrganizationSubscriptionRepo,
  IMembershipRepo,
  IOrganizationInvitationRepo,
  IFolderRepo,
  IResourceRepo,
  ISyncStateRepo,
  ISyncRecordRepo,
  ISyncNonceRepo,
  ISyncMutationRepo,
  ISyncResetTokenRepo,
  ISyncResetHandoffRepo,
  IIdempotencyReceiptRepo,
  MemberDto,
  OrganizationSummary,
  InvitationDto,
  ResourceSummaryDto,
  RegistrationAccountInput,
  RegistrationResult,
  AdminUserFilter,
  AdminUserRow,
  AdminOrgFilter,
  AdminOrgRow,
} from '../../src/repository/interfaces.js';
import type {
  User,
  EmailVerificationToken,
  PersonalPlan,
  PersonalSubscription,
  Device,
  RefreshToken,
  Organization,
  OrganizationPlan,
  OrganizationSubscription,
  OrganizationMembership,
  OrganizationInvitation,
  Folder,
  Resource,
  PersonalSyncState,
  PersonalConnectionMeta,
  SyncMutation,
  SyncResetToken,
  SyncResetHandoff,
  IdempotencyReceipt,
} from '../../src/domain/entities.js';
import type {
  UserStatus,
  UserRole,
  EmailVerificationPurpose,
  OrganizationRole,
  OrganizationMembershipStatus,
  OrganizationSubscriptionStatus,
  ResourceType,
  SyncAction,
  SyncMutationStatus,
  SyncResetHandoffStatus,
} from '../../src/domain/enums.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import { ConflictError } from '../../src/domain/errors.js';

/**
 * 内存假仓储（测试替身）：与真实 Mysql*Repo 同语义，不连 MySQL。
 * exec（事务连接）参数会被忽略 —— 内存操作天然原子，无需真实事务。
 */

let seq = 0;
const nextId = () => ++seq;

export class FakeUserRepo implements IUserRepo {
  readonly store = new Map<number, User>();
  private readonly emailIndex = new Map<string, number>();

  async findById(id: number): Promise<User | undefined> {
    return this.store.get(id);
  }

  async lockById(_exec: Queryable, id: number): Promise<User | undefined> {
    return this.store.get(id);
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const id = this.emailIndex.get(email);
    return id === undefined ? undefined : this.store.get(id);
  }

  async findByIdInTx(_exec: Queryable, id: number): Promise<User | undefined> {
    return this.store.get(id);
  }

  async findByEmailInTx(_exec: Queryable, email: string): Promise<User | undefined> {
    const id = this.emailIndex.get(email);
    return id === undefined ? undefined : this.store.get(id);
  }

  async create(email: string, passwordHash: string, displayName?: string): Promise<User> {
    if (this.emailIndex.has(email)) throw new ConflictError(`user already exists: ${email}`);
    const user: User = {
      id: nextId(),
      email,
      emailVerifiedTime: null,
      passwordHash,
      displayName,
      status: 'active',
      role: 'user',
      lastLoginTime: null,
      sessionVersion: 0,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(user.id, user);
    this.emailIndex.set(email, user.id);
    return user;
  }

  async updateLastLogin(id: number, time: Date): Promise<void> {
    const u = this.store.get(id);
    if (u) u.lastLoginTime = time;
  }

  async updatePassword(_exec: Queryable, id: number, passwordHash: string): Promise<void> {
    const u = this.store.get(id);
    if (u) u.passwordHash = passwordHash;
  }

  async updateStatus(id: number, status: UserStatus): Promise<void> {
    const u = this.store.get(id);
    if (u) u.status = status;
  }

  async updateStatusInTx(_exec: Queryable, id: number, status: UserStatus): Promise<void> {
    const u = this.store.get(id);
    if (u) u.status = status;
  }

  async setRole(id: number, role: UserRole): Promise<void> {
    const u = this.store.get(id);
    if (u) u.role = role;
  }

  async listUsers(input: AdminUserFilter): Promise<AdminUserRow[]> {
    return this.filterUsers(input)
      .sort((a, b) => b.userId - a.userId)
      .slice(0, input.limit);
  }

  async countUsers(input: Omit<AdminUserFilter, 'cursor' | 'limit'>): Promise<number> {
    return this.filterUsers({ ...input, limit: Number.MAX_SAFE_INTEGER }).length;
  }

  private filterUsers(input: AdminUserFilter): AdminUserRow[] {
    return Array.from(this.store.values())
      .filter((u) => {
        if (input.userId !== undefined && u.id !== input.userId) return false;
        if (input.emailExact && u.email !== input.emailExact) return false;
        if (input.status !== undefined && u.status !== input.status) return false;
        if (input.createdFrom && u.createTime < input.createdFrom) return false;
        if (input.createdTo && u.createTime > input.createdTo) return false;
        if (input.cursor !== undefined && u.id >= input.cursor) return false;
        if (input.planCode) return false;
        return true;
      })
      .map((u) => ({
        userId: u.id,
        email: u.email,
        emailVerifiedTime: u.emailVerifiedTime,
        displayName: u.displayName,
        status: u.status,
        role: u.role,
        lastLoginTime: u.lastLoginTime,
        createTime: u.createTime,
        planCode: null,
        deviceCount: 0,
        subscriptionVersion: null,
        periodEndTime: null,
      }));
  }

  async markEmailVerified(_exec: Queryable, id: number, time: Date): Promise<void> {
    const u = this.store.get(id);
    if (u) u.emailVerifiedTime = time;
  }

  async incrementSessionVersion(_exec: Queryable, id: number): Promise<void> {
    const u = this.store.get(id);
    if (u) u.sessionVersion += 1;
  }

  async updateDisplayName(id: number, displayName: string): Promise<void> {
    const u = this.store.get(id);
    if (u) u.displayName = displayName;
  }

  async updateDisplayNameInTx(_exec: Queryable, id: number, displayName: string): Promise<void> {
    const u = this.store.get(id);
    if (u) u.displayName = displayName;
  }
}

export class FakeEmailVerificationTokenRepo implements IEmailVerificationTokenRepo {
  readonly store = new Map<number, EmailVerificationToken>();

  async create(_exec: Queryable, input: {
    userId: number;
    email: string;
    purpose: EmailVerificationPurpose;
    tokenHash: string;
    expiresTime: Date;
  }): Promise<EmailVerificationToken> {
    const t: EmailVerificationToken = {
      id: nextId(),
      userId: input.userId,
      email: input.email,
      purpose: input.purpose,
      tokenHash: input.tokenHash,
      expiresTime: input.expiresTime,
      consumedTime: null,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(t.id, t);
    return t;
  }

  async findByHash(tokenHash: string): Promise<EmailVerificationToken | undefined> {
    for (const t of this.store.values()) if (t.tokenHash === tokenHash) return t;
    return undefined;
  }

  async findByHashForUpdate(_exec: Queryable, tokenHash: string): Promise<EmailVerificationToken | undefined> {
    return this.findByHash(tokenHash);
  }

  async findByIdForUpdate(_exec: Queryable, id: number): Promise<EmailVerificationToken | undefined> {
    return this.store.get(id);
  }

  async findByIdInTx(_exec: Queryable, id: number): Promise<EmailVerificationToken | undefined> {
    return this.store.get(id);
  }

  async consume(_exec: Queryable, id: number, now: Date): Promise<boolean> {
    const t = this.store.get(id);
    if (!t || t.consumedTime || t.expiresTime <= now) return false;
    t.consumedTime = now;
    return true;
  }

  async invalidate(_exec: Queryable, userId: number, email: string, purpose: EmailVerificationPurpose, now: Date): Promise<void> {
    for (const t of this.store.values()) {
      if (t.userId === userId && t.email === email && t.purpose === purpose && !t.consumedTime) {
        t.consumedTime = now;
      }
    }
  }

  async prune(before: Date, limit: number): Promise<number> {
    let n = 0;
    for (const [id, t] of [...this.store]) {
      if (n >= limit) break;
      if (t.expiresTime < before || (t.consumedTime && t.consumedTime < before)) { this.store.delete(id); n++; }
    }
    return n;
  }
}

export function makeFreePlan(id = nextId()): PersonalPlan {
  return {
    id,
    code: 'free',
    name: 'Free',
    allowedDatabaseTypes: ['mysql', 'sqlite'],
    maxDevices: 0,
    maxConnectionMetas: 500,
    syncStorageBytes: 33554432,
    maxSavedConnections: 10,
    allowConnectionImport: false,
    status: 'active',
    createTime: new Date(),
    updateTime: new Date(),
  };
}

export class FakePersonalPlanRepo implements IPersonalPlanRepo {
  constructor(private readonly plans: PersonalPlan[] = [makeFreePlan()]) {}

  async findByCode(code: string): Promise<PersonalPlan | undefined> {
    return this.plans.find((p) => p.code === code);
  }

  async findById(id: number): Promise<PersonalPlan | undefined> {
    return this.plans.find((p) => p.id === id);
  }

  async findByCodeInTx(_exec: Queryable, code: string): Promise<PersonalPlan | undefined> {
    return this.findByCode(code);
  }

  async listActive(): Promise<PersonalPlan[]> {
    return this.plans.filter((p) => p.status === 'active');
  }
}

export class FakePersonalSubscriptionRepo implements IPersonalSubscriptionRepo {
  readonly store = new Map<number, PersonalSubscription>();

  async findByUserId(userId: number): Promise<PersonalSubscription | undefined> {
    for (const s of this.store.values()) if (s.userId === userId) return s;
    return undefined;
  }

  async findByUserIdInTx(_exec: Queryable, userId: number): Promise<PersonalSubscription | undefined> {
    for (const s of this.store.values()) if (s.userId === userId) return s;
    return undefined;
  }

  async findByUserIdForUpdate(_exec: Queryable, userId: number): Promise<PersonalSubscription | undefined> {
    for (const s of this.store.values()) if (s.userId === userId) return s;
    return undefined;
  }

  async update(_exec: Queryable, input: {
    id: number;
    planId: number;
    status: PersonalSubscription['status'];
    entitlementSnapshot: Record<string, unknown>;
    periodEndTime: Date | null;
    expectedVersion: number;
  }): Promise<boolean> {
    const s = this.store.get(input.id);
    if (!s || s.version !== input.expectedVersion) return false;
    s.planId = input.planId;
    s.status = input.status;
    s.entitlementSnapshot = input.entitlementSnapshot;
    s.periodEndTime = input.periodEndTime;
    s.version += 1;
    return true;
  }

  async create(input: {
    userId: number;
    planId: number;
    status: PersonalSubscription['status'];
    entitlementSnapshot: Record<string, unknown>;
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<PersonalSubscription> {
    const s: PersonalSubscription = {
      id: nextId(),
      userId: input.userId,
      planId: input.planId,
      status: input.status,
      entitlementSnapshot: input.entitlementSnapshot,
      periodStartTime: input.periodStartTime,
      periodEndTime: input.periodEndTime,
      version: 0,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(s.id, s);
    return s;
  }
}

export class FakeDeviceRepo implements IDeviceRepo {
  readonly store = new Map<number, Device>();

  async upsert(_exec: Queryable, device: Omit<Device, 'id' | 'createTime' | 'updateTime'>): Promise<Device> {
    const existing = await this.findByUserAndKey(_exec, device.userId, device.deviceKey);
    if (existing) {
      existing.devicePlatform = device.devicePlatform;
      existing.deviceName = device.deviceName;
      existing.clientVersion = device.clientVersion;
      existing.status = 'active';
      existing.lastUsedTime = device.lastUsedTime ?? existing.lastUsedTime;
      return existing;
    }
    const d: Device = {
      id: nextId(),
      userId: device.userId,
      deviceKey: device.deviceKey,
      devicePlatform: device.devicePlatform,
      deviceName: device.deviceName,
      clientVersion: device.clientVersion,
      status: 'active',
      lastUsedTime: device.lastUsedTime ?? null,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(d.id, d);
    return d;
  }

  async findByUserAndKey(_exec: Queryable, userId: number, deviceKey: string): Promise<Device | undefined> {
    for (const d of this.store.values()) if (d.userId === userId && d.deviceKey === deviceKey) return d;
    return undefined;
  }

  async findByIdForUpdate(_exec: Queryable, id: number): Promise<Device | undefined> {
    return this.store.get(id);
  }

  async listByUser(userId: number): Promise<Device[]> {
    return [...this.store.values()].filter((d) => d.userId === userId);
  }

  async countActive(_exec: Queryable, userId: number): Promise<number> {
    return [...this.store.values()].filter((d) => d.userId === userId && d.status === 'active' && d.devicePlatform !== 'web').length;
  }

  async revoke(_exec: Queryable, id: number, now: Date): Promise<void> {
    const d = this.store.get(id);
    if (d) {
      d.status = 'revoked';
      d.lastUsedTime = now;
    }
  }

  async touch(_exec: Queryable, id: number, now: Date): Promise<void> {
    const d = this.store.get(id);
    if (d) d.lastUsedTime = now;
  }

  async findActiveByUserAndPlatform(_exec: Queryable, userId: number, platform: string): Promise<Device | undefined> {
    for (const d of this.store.values()) {
      if (d.userId === userId && d.devicePlatform === platform && d.status === 'active') return d;
    }
    return undefined;
  }
}

export class FakeRefreshTokenRepo implements IRefreshTokenRepo {
  readonly store = new Map<number, RefreshToken>();

  async create(_exec: Queryable, input: {
    userId: number;
    deviceId: number | null;
    tokenHash: string;
    familyId: string;
    replacedByTokenId: number | null;
    expiresTime: Date;
  }): Promise<RefreshToken> {
    const t: RefreshToken = {
      id: nextId(),
      userId: input.userId,
      deviceId: input.deviceId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      replacedByTokenId: input.replacedByTokenId,
      expiresTime: input.expiresTime,
      revokedTime: null,
      lastUsedTime: null,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(t.id, t);
    return t;
  }

  async findByHash(tokenHash: string): Promise<RefreshToken | undefined> {
    for (const t of this.store.values()) if (t.tokenHash === tokenHash) return t;
    return undefined;
  }

  async findByHashForUpdate(_exec: Queryable, tokenHash: string): Promise<RefreshToken | undefined> {
    return this.findByHash(tokenHash);
  }

  async findById(id: number): Promise<RefreshToken | undefined> {
    return this.store.get(id);
  }

  async consume(_exec: Queryable, id: number, now: Date): Promise<boolean> {
    const t = this.store.get(id);
    if (!t || t.revokedTime) return false;
    t.revokedTime = now;
    t.lastUsedTime = now;
    return true;
  }

  async revokeFamily(_exec: Queryable, familyId: string, now: Date): Promise<void> {
    for (const t of this.store.values()) if (t.familyId === familyId && !t.revokedTime) t.revokedTime = now;
  }

  async revokeByDevice(_exec: Queryable, deviceId: number, now: Date): Promise<void> {
    for (const t of this.store.values()) if (t.deviceId === deviceId && !t.revokedTime) t.revokedTime = now;
  }

  async revokeAllForUser(_exec: Queryable, userId: number, now: Date): Promise<void> {
    for (const t of this.store.values()) if (t.userId === userId && !t.revokedTime) t.revokedTime = now;
  }

  async hasActiveToken(familyId: string): Promise<boolean> {
    for (const t of this.store.values()) {
      if (t.familyId === familyId && !t.revokedTime && t.expiresTime > new Date()) return true;
    }
    return false;
  }

  async prune(before: Date, limit: number): Promise<number> {
    let n = 0;
    for (const [id, t] of [...this.store]) {
      if (n >= limit) break;
      if (t.expiresTime < before || (t.revokedTime && t.revokedTime < before)) { this.store.delete(id); n++; }
    }
    return n;
  }
}

export class FakeRateLimitRepo implements IRateLimitRepo {
  readonly store = new Map<string, number>();

  private key(bucketKey: string, windowStartTime: Date): string {
    return `${bucketKey}|${windowStartTime.toISOString()}`;
  }

  async increment(bucketKey: string, windowStartTime: Date): Promise<number> {
    const k = this.key(bucketKey, windowStartTime);
    const next = (this.store.get(k) ?? 0) + 1;
    this.store.set(k, next);
    return next;
  }

  async incrementInTx(_exec: Queryable, bucketKey: string, windowStartTime: Date): Promise<number> {
    return this.increment(bucketKey, windowStartTime);
  }

  async peek(bucketKey: string, windowStartTime: Date): Promise<number> {
    return this.store.get(this.key(bucketKey, windowStartTime)) ?? 0;
  }

  async prune(before: Date): Promise<void> {
    for (const k of [...this.store.keys()]) {
      const iso = k.slice(k.lastIndexOf('|') + 1);
      if (new Date(iso) < before) this.store.delete(k);
    }
  }
}

export class FakeRegistrationRepo implements IRegistrationRepo {
  constructor(
    private readonly plans: IPersonalPlanRepo,
    private readonly users: IUserRepo,
    private readonly subs: IPersonalSubscriptionRepo,
    private readonly tokens: IEmailVerificationTokenRepo,
  ) {}

  async createAccount(input: RegistrationAccountInput): Promise<RegistrationResult> {
    const freePlan = await this.plans.findByCode('free');
    if (!freePlan) throw new Error('free plan is missing');

    if (await this.users.findByEmail(input.email)) {
      throw new ConflictError(`user already exists: ${input.email}`);
    }
    const user = await this.users.create(input.email, input.passwordHash, input.displayName);
    const entitlementSnapshot = {
      allowedDatabaseTypes: freePlan.allowedDatabaseTypes,
      maxDevices: freePlan.maxDevices,
      maxConnectionMetas: freePlan.maxConnectionMetas,
      syncStorageBytes: freePlan.syncStorageBytes,
    };
    await this.subs.create({
      userId: user.id,
      planId: freePlan.id,
      status: 'active',
      entitlementSnapshot,
      periodStartTime: new Date(),
      periodEndTime: null,
    });
    await this.tokens.create({} as Queryable, {
      userId: user.id,
      email: input.email,
      purpose: 'initial',
      tokenHash: input.verificationTokenHash,
      expiresTime: input.verificationExpiresTime,
    });
    return { userId: user.id };
  }
}
export function makeOrganizationFreePlan(id = nextId()): OrganizationPlan {
  return {
    id,
    code: 'organization_free',
    name: 'Organization Free',
    includedSeats: 3,
    maxSharedResources: 50,
    sharedStorageQuotaBytes: 10485760,
    allowedTemplateDatabaseTypes: ['mysql'],
    status: 'active',
    createTime: new Date(),
    updateTime: new Date(),
  };
}

export class FakeOrganizationPlanRepo implements IOrganizationPlanRepo {
  constructor(private readonly plans: OrganizationPlan[] = [makeOrganizationFreePlan()]) {}

  async findByCode(code: string): Promise<OrganizationPlan | undefined> {
    return this.plans.find((p) => p.code === code);
  }

  async findById(id: number): Promise<OrganizationPlan | undefined> {
    return this.plans.find((p) => p.id === id);
  }

  async findByCodeForUpdate(_exec: Queryable, code: string): Promise<OrganizationPlan | undefined> {
    return this.findByCode(code);
  }

  async listActive(): Promise<OrganizationPlan[]> {
    return this.plans.filter((p) => p.status === 'active');
  }
}

export class FakeOrganizationRepo implements IOrganizationRepo {
  readonly store = new Map<number, Organization>();

  async findById(id: number): Promise<Organization | undefined> {
    return this.store.get(id);
  }

  async lockById(_exec: Queryable, id: number): Promise<Organization | undefined> {
    return this.store.get(id);
  }

  async create(_exec: Queryable, input: { name: string }): Promise<Organization> {
    const o: Organization = {
      id: nextId(),
      name: input.name,
      status: 'active',
      closedTime: null,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(o.id, o);
    return o;
  }

  async updateName(_exec: Queryable, id: number, name: string): Promise<void> {
    const o = this.store.get(id);
    if (o) o.name = name;
  }

  async close(_exec: Queryable, id: number, closedTime: Date): Promise<void> {
    const o = this.store.get(id);
    if (o) {
      o.status = 'closed';
      o.closedTime = closedTime;
    }
  }

  async listForAdmin(input: AdminOrgFilter): Promise<AdminOrgRow[]> {
    return Array.from(this.store.values())
      .filter((o) => {
        if (input.namePrefix && !o.name.startsWith(input.namePrefix)) return false;
        if (input.status !== undefined && o.status !== input.status) return false;
        if (input.planCode) return false;
        if (input.cursor !== undefined && o.id >= input.cursor) return false;
        return true;
      })
      .sort((a, b) => b.id - a.id)
      .slice(0, input.limit)
      .map((o) => ({
        organizationId: o.id,
        name: o.name,
        status: o.status,
        planCode: 'organization_free',
        seatLimit: null,
        activeMemberCount: 0,
        invitedCount: 0,
        createTime: o.createTime,
        subscriptionVersion: null,
        periodEndTime: null,
      }));
  }

  async countForAdmin(input: Omit<AdminOrgFilter, 'cursor' | 'limit'>): Promise<number> {
    return (await this.listForAdmin({ ...input, limit: Number.MAX_SAFE_INTEGER })).length;
  }
}

export class FakeOrganizationSubscriptionRepo implements IOrganizationSubscriptionRepo {
  readonly store = new Map<number, OrganizationSubscription>();

  async findByOrganizationId(organizationId: number): Promise<OrganizationSubscription | undefined> {
    for (const s of this.store.values()) if (s.organizationId === organizationId) return s;
    return undefined;
  }

  async findByOrganizationIdForUpdate(_exec: Queryable, organizationId: number): Promise<OrganizationSubscription | undefined> {
    return this.findByOrganizationId(organizationId);
  }

  async create(_exec: Queryable, input: {
    organizationId: number;
    planId: number;
    seatLimit: number;
    status: OrganizationSubscriptionStatus;
    entitlementSnapshot: Record<string, unknown>;
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<OrganizationSubscription> {
    const s: OrganizationSubscription = {
      id: nextId(),
      organizationId: input.organizationId,
      planId: input.planId,
      seatLimit: input.seatLimit,
      status: input.status,
      entitlementSnapshot: input.entitlementSnapshot,
      periodStartTime: input.periodStartTime,
      periodEndTime: input.periodEndTime,
      version: 0,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(s.id, s);
    return s;
  }

  async update(_exec: Queryable, input: {
    id: number;
    planId: number;
    seatLimit: number;
    status: OrganizationSubscriptionStatus;
    entitlementSnapshot: Record<string, unknown>;
    periodEndTime: Date | null;
    expectedVersion: number;
  }): Promise<boolean> {
    const s = this.store.get(input.id);
    if (!s || s.version !== input.expectedVersion) return false;
    s.planId = input.planId;
    s.seatLimit = input.seatLimit;
    s.status = input.status;
    s.entitlementSnapshot = input.entitlementSnapshot;
    s.periodEndTime = input.periodEndTime;
    s.version += 1;
    return true;
  }
}

export class FakeMembershipRepo implements IMembershipRepo {
  readonly store = new Map<number, OrganizationMembership>();

  constructor(
    private readonly userRepo?: IUserRepo,
    private readonly organizationRepo?: IOrganizationRepo,
  ) {}

  async create(_exec: Queryable, input: {
    organizationId: number;
    userId: number;
    role: OrganizationRole;
    status: OrganizationMembershipStatus;
    invitedByUserId: number | null;
    joinedTime: Date | null;
    removedTime: Date | null;
  }): Promise<OrganizationMembership> {
    const m: OrganizationMembership = {
      id: nextId(),
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      status: input.status,
      invitedByUserId: input.invitedByUserId,
      joinedTime: input.joinedTime,
      removedTime: input.removedTime,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(m.id, m);
    return m;
  }

  async listByOrganization(organizationId: number): Promise<MemberDto[]> {
    const out: MemberDto[] = [];
    for (const m of this.store.values()) {
      if (m.organizationId === organizationId && (m.status === 'active' || m.status === 'invited')) {
        const u = this.userRepo ? await this.userRepo.findById(m.userId) : undefined;
        out.push({
          membershipId: m.id,
          userId: m.userId,
          displayName: u?.displayName,
          role: m.role,
          status: m.status,
          joinedTime: m.joinedTime,
        });
      }
    }
    return out.sort((a, b) => a.membershipId - b.membershipId);
  }

  async listActiveByUser(userId: number): Promise<OrganizationMembership[]> {
    return [...this.store.values()].filter((m) => m.userId === userId && m.status === 'active');
  }

  async listActiveByUserWithOrg(userId: number): Promise<OrganizationSummary[]> {
    const out: OrganizationSummary[] = [];
    for (const m of this.store.values()) {
      if (m.userId !== userId || m.status !== 'active') continue;
      const org = this.organizationRepo ? await this.organizationRepo.findById(m.organizationId) : undefined;
      if (!org || org.status !== 'active') continue;
      out.push({ organizationId: org.id, name: org.name, status: org.status, closedTime: org.closedTime, role: m.role });
    }
    return out.sort((a, b) => a.organizationId - b.organizationId);
  }

  async findByOrgAndUser(organizationId: number, userId: number): Promise<OrganizationMembership | undefined> {
    for (const m of this.store.values()) if (m.organizationId === organizationId && m.userId === userId) return m;
    return undefined;
  }

  async findByOrgAndUserForUpdate(_exec: Queryable, organizationId: number, userId: number): Promise<OrganizationMembership | undefined> {
    return this.findByOrgAndUser(organizationId, userId);
  }

  async findByIdForUpdate(_exec: Queryable, id: number): Promise<OrganizationMembership | undefined> {
    return this.store.get(id);
  }

  async updateRole(_exec: Queryable, id: number, role: OrganizationRole): Promise<void> {
    const m = this.store.get(id);
    if (m) m.role = role;
  }

  async remove(_exec: Queryable, id: number, now: Date): Promise<void> {
    const m = this.store.get(id);
    if (m) {
      m.status = 'removed';
      m.removedTime = now;
    }
  }

  async removeInvitedByOrganization(_exec: Queryable, organizationId: number, now: Date): Promise<void> {
    for (const m of this.store.values()) {
      if (m.organizationId === organizationId && m.status === 'invited') {
        m.status = 'removed';
        m.removedTime = now;
      }
    }
  }

  async upsertInvited(_exec: Queryable, input: {
    organizationId: number;
    userId: number;
    role: OrganizationRole;
    invitedByUserId: number;
  }): Promise<OrganizationMembership> {
    const existing = await this.findByOrgAndUser(input.organizationId, input.userId);
    if (existing) {
      existing.role = input.role;
      existing.status = 'invited';
      existing.invitedByUserId = input.invitedByUserId;
      existing.joinedTime = null;
      existing.removedTime = null;
      return existing;
    }
    return this.create(_exec, {
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      status: 'invited',
      invitedByUserId: input.invitedByUserId,
      joinedTime: null,
      removedTime: null,
    });
  }

  async activate(_exec: Queryable, id: number, now: Date): Promise<void> {
    const m = this.store.get(id);
    if (m) {
      m.status = 'active';
      m.joinedTime = now;
      m.removedTime = null;
    }
  }

  async countActive(_exec: Queryable, organizationId: number): Promise<number> {
    return [...this.store.values()].filter((m) => m.organizationId === organizationId && m.status === 'active').length;
  }

  async countValidInvited(_exec: Queryable, organizationId: number, _now: Date): Promise<number> {
    // fake 维护不变式：'invited' membership 恒对应一个 pending 邀请（撤销/过期/接受都会翻转 status）。
    return [...this.store.values()].filter((m) => m.organizationId === organizationId && m.status === 'invited').length;
  }

  async countActiveAdmins(_exec: Queryable, organizationId: number): Promise<number> {
    return [...this.store.values()].filter((m) => m.organizationId === organizationId && m.role === 'admin' && m.status === 'active').length;
  }
}

export class FakeInvitationRepo implements IOrganizationInvitationRepo {
  readonly store = new Map<number, OrganizationInvitation>();

  constructor(private readonly membershipRepo?: IMembershipRepo) {}

  async create(_exec: Queryable, input: {
    organizationId: number;
    membershipId: number;
    email: string;
    tokenHash: string;
    expiresTime: Date;
  }): Promise<OrganizationInvitation> {
    const inv: OrganizationInvitation = {
      id: nextId(),
      organizationId: input.organizationId,
      membershipId: input.membershipId,
      email: input.email,
      tokenHash: input.tokenHash,
      expiresTime: input.expiresTime,
      acceptedTime: null,
      revokedTime: null,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(inv.id, inv);
    return inv;
  }

  async findByTokenHash(tokenHash: string): Promise<OrganizationInvitation | undefined> {
    for (const i of this.store.values()) if (i.tokenHash === tokenHash) return i;
    return undefined;
  }

  async findById(id: number): Promise<OrganizationInvitation | undefined> {
    return this.store.get(id);
  }

  async findByIdForUpdate(_exec: Queryable, id: number): Promise<OrganizationInvitation | undefined> {
    return this.store.get(id);
  }

  async findByTokenHashForUpdate(_exec: Queryable, tokenHash: string): Promise<OrganizationInvitation | undefined> {
    return this.findByTokenHash(tokenHash);
  }

  async revokeByMembership(_exec: Queryable, membershipId: number, now: Date): Promise<void> {
    for (const i of this.store.values()) {
      if (i.membershipId === membershipId && !i.acceptedTime && !i.revokedTime) i.revokedTime = now;
    }
  }

  async revokeByOrganization(_exec: Queryable, organizationId: number, now: Date): Promise<void> {
    for (const i of this.store.values()) {
      if (i.organizationId === organizationId && !i.acceptedTime && !i.revokedTime) i.revokedTime = now;
    }
  }

  async markAccepted(_exec: Queryable, id: number, now: Date): Promise<void> {
    const i = this.store.get(id);
    if (i) i.acceptedTime = now;
  }

  async markRevoked(_exec: Queryable, id: number, now: Date): Promise<void> {
    const i = this.store.get(id);
    if (i) i.revokedTime = now;
  }

  async listActiveByOrganization(organizationId: number, now: Date): Promise<InvitationDto[]> {
    const out: InvitationDto[] = [];
    for (const i of this.store.values()) {
      if (i.organizationId !== organizationId || i.acceptedTime || i.revokedTime || i.expiresTime <= now) continue;
      const m = this.membershipRepo ? await this.membershipRepo.findByIdForUpdate({} as Queryable, i.membershipId) : undefined;
      out.push({
        invitationId: i.id,
        email: i.email,
        role: (m?.role ?? 'member') as OrganizationRole,
        expiresTime: i.expiresTime,
        invitedTime: i.createTime,
      });
    }
    return out.sort((a, b) => a.invitationId - b.invitationId);
  }

  async hasValidInvitation(_exec: Queryable, membershipId: number, now: Date): Promise<boolean> {
    for (const i of this.store.values()) {
      if (i.membershipId === membershipId && !i.acceptedTime && !i.revokedTime && i.expiresTime > now) return true;
    }
    return false;
  }

  async findExpiredOrganizationIds(now: Date): Promise<number[]> {
    const ids = new Set<number>();
    for (const i of this.store.values()) {
      if (!i.acceptedTime && !i.revokedTime && i.expiresTime <= now) ids.add(i.organizationId);
    }
    return [...ids];
  }

  async expireByOrganization(_exec: Queryable, organizationId: number, now: Date): Promise<void> {
    for (const i of this.store.values()) {
      if (i.organizationId === organizationId && !i.acceptedTime && !i.revokedTime && i.expiresTime <= now) {
        i.revokedTime = now;
        // 与 SQL 实现保持一致：只移除**仍是 invited** 的成员行。
        // 缺这个守卫会让过期清理静默移除已 active 的真实成员（可能是最后一个 admin）。
        if (this.membershipRepo) {
          const m = await this.membershipRepo.findByIdForUpdate({} as Queryable, i.membershipId);
          if (m?.status === 'invited') {
            await this.membershipRepo.remove({} as Queryable, i.membershipId, now);
          }
        }
      }
    }
  }
}

export class FakeFolderRepo implements IFolderRepo {
  readonly store = new Map<number, Folder>();

  constructor(private readonly resourceRepo?: FakeResourceRepo) {}

  async create(_exec: Queryable, input: { organizationId: number; parentId: number | null; name: string }): Promise<Folder> {
    const folder: Folder = {
      id: nextId(),
      organizationId: input.organizationId,
      parentId: input.parentId,
      name: input.name,
      deleteTime: null,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(folder.id, folder);
    return folder;
  }

  async findByIdForUpdate(_exec: Queryable, organizationId: number, id: number): Promise<Folder | undefined> {
    const f = this.store.get(id);
    return f && f.organizationId === organizationId ? f : undefined;
  }

  async listActive(organizationId: number): Promise<Folder[]> {
    return [...this.store.values()]
      .filter((f) => f.organizationId === organizationId && !f.deleteTime)
      .sort((a, b) => a.id - b.id);
  }

  async countActiveChildren(_exec: Queryable, organizationId: number, parentId: number): Promise<number> {
    return [...this.store.values()].filter((f) => f.organizationId === organizationId && f.parentId === parentId && !f.deleteTime).length;
  }

  async countActiveResources(_exec: Queryable, organizationId: number, folderId: number): Promise<number> {
    if (!this.resourceRepo) return 0;
    let n = 0;
    for (const r of this.resourceRepo.store.values()) {
      if (r.organizationId === organizationId && r.folderId === folderId && !r.deleteTime) n++;
    }
    return n;
  }

  async updateName(_exec: Queryable, id: number, name: string, _organizationId: number): Promise<void> {
    const f = this.store.get(id);
    if (f) f.name = name;
  }

  async updateParent(_exec: Queryable, id: number, parentId: number | null, _organizationId: number): Promise<void> {
    const f = this.store.get(id);
    if (f) f.parentId = parentId;
  }

  async softDelete(_exec: Queryable, id: number, _organizationId: number, now: Date): Promise<void> {
    const f = this.store.get(id);
    if (f) f.deleteTime = now;
  }

  async collectDescendantIds(_exec: Queryable, organizationId: number, folderId: number): Promise<number[]> {
    const out = new Set<number>([folderId]);
    let added = true;
    while (added) {
      added = false;
      for (const f of this.store.values()) {
        if (f.organizationId === organizationId && !f.deleteTime && f.parentId !== null && out.has(f.parentId) && !out.has(f.id)) {
          out.add(f.id);
          added = true;
        }
      }
    }
    return [...out];
  }
}

export class FakeResourceRepo implements IResourceRepo {
  readonly store = new Map<number, Resource>();

  async create(_exec: Queryable, input: {
    organizationId: number;
    folderId: number | null;
    resourceType: ResourceType;
    name: string;
    content: Record<string, unknown>;
    version: number;
    createdByMembershipId: number;
  }): Promise<Resource> {
    const resource: Resource = {
      id: nextId(),
      organizationId: input.organizationId,
      folderId: input.folderId,
      resourceType: input.resourceType,
      name: input.name,
      content: input.content,
      version: input.version,
      createdByMembershipId: input.createdByMembershipId,
      updatedByMembershipId: null,
      deleteTime: null,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(resource.id, resource);
    return resource;
  }

  async findById(organizationId: number, id: number): Promise<Resource | undefined> {
    const r = this.store.get(id);
    return r && r.organizationId === organizationId ? r : undefined;
  }

  async findByIdForUpdate(_exec: Queryable, organizationId: number, id: number): Promise<Resource | undefined> {
    const r = this.store.get(id);
    return r && r.organizationId === organizationId ? r : undefined;
  }

  async listActiveByOrganization(organizationId: number): Promise<ResourceSummaryDto[]> {
    return [...this.store.values()]
      .filter((r) => r.organizationId === organizationId && !r.deleteTime)
      .sort((a, b) => a.id - b.id)
      .map(toResourceSummary);
  }

  async listActiveContent(_exec: Queryable, organizationId: number): Promise<Record<string, unknown>[]> {
    return [...this.store.values()]
      .filter((r) => r.organizationId === organizationId && !r.deleteTime)
      .map((r) => r.content);
  }

  async update(_exec: Queryable, input: {
    id: number;
    organizationId: number;
    name: string;
    folderId: number | null;
    content: Record<string, unknown>;
    baseVersion: number;
    updatedByMembershipId: number;
  }): Promise<boolean> {
    const r = this.store.get(input.id);
    if (!r || r.organizationId !== input.organizationId || r.deleteTime || r.version !== input.baseVersion) return false;
    r.name = input.name;
    r.folderId = input.folderId;
    r.content = input.content;
    r.version = input.baseVersion + 1;
    r.updatedByMembershipId = input.updatedByMembershipId;
    return true;
  }

  async softDelete(_exec: Queryable, id: number, organizationId: number, now: Date, deletedByMembershipId: number): Promise<void> {
    const r = this.store.get(id);
    if (r && r.organizationId === organizationId && !r.deleteTime) {
      r.deleteTime = now;
      r.updatedByMembershipId = deletedByMembershipId;
    }
  }
}

function toResourceSummary(r: Resource): ResourceSummaryDto {
  return {
    resourceId: r.id,
    resourceType: r.resourceType,
    name: r.name,
    folderId: r.folderId,
    version: r.version,
    createdByMembershipId: r.createdByMembershipId,
    updatedByMembershipId: r.updatedByMembershipId,
  };
}

// ── 个人 E2E 同步（§7 专项）──

export class FakeSyncStateRepo implements ISyncStateRepo {
  readonly store = new Map<number, PersonalSyncState>();

  async findByUserId(userId: number): Promise<PersonalSyncState | undefined> {
    return this.store.get(userId);
  }

  async lockByUserId(_exec: Queryable, userId: number): Promise<PersonalSyncState | undefined> {
    return this.store.get(userId);
  }

  async create(_exec: Queryable, state: Omit<PersonalSyncState, 'createTime' | 'updateTime'>): Promise<boolean> {
    if (this.store.has(state.userId)) return false;
    this.store.set(state.userId, { ...state, createTime: new Date(), updateTime: new Date() });
    return true;
  }

  async update(_exec: Queryable, userId: number, expectedStateVersion: string, state: Omit<PersonalSyncState, 'createTime' | 'updateTime'>): Promise<boolean> {
    const cur = this.store.get(userId);
    if (!cur || cur.stateVersion !== expectedStateVersion) return false;
    this.store.set(userId, { ...state, createTime: cur.createTime, updateTime: new Date() });
    return true;
  }
}

export class FakeSyncRecordRepo implements ISyncRecordRepo {
  readonly store = new Map<string, PersonalConnectionMeta>();

  private key(userId: number, keyEpoch: string, recordId: Buffer): string {
    return `${userId}:${keyEpoch}:${recordId.toString('base64url')}`;
  }

  async create(_exec: Queryable, input: {
    userId: number; keyEpoch: string; recordId: Buffer;
    cipherSuite: PersonalConnectionMeta['cipherSuite']; formatVersion: PersonalConnectionMeta['formatVersion'];
    nonce: Buffer; ciphertext: Buffer; tag: Buffer; version: string; changeSequence: string;
  }): Promise<PersonalConnectionMeta> {
    const meta: PersonalConnectionMeta = {
      id: nextId(),
      userId: input.userId, keyEpoch: input.keyEpoch, recordId: input.recordId,
      cipherSuite: input.cipherSuite, formatVersion: input.formatVersion,
      nonce: input.nonce, ciphertext: input.ciphertext, tag: input.tag,
      version: input.version, changeSequence: input.changeSequence,
      updateTime: new Date(), deleteTime: null,
    };
    this.store.set(this.key(input.userId, input.keyEpoch, input.recordId), meta);
    return meta;
  }

  async findForUpdate(_exec: Queryable, userId: number, keyEpoch: string, recordId: Buffer): Promise<PersonalConnectionMeta | undefined> {
    return this.store.get(this.key(userId, keyEpoch, recordId));
  }

  async update(_exec: Queryable, input: {
    userId: number; keyEpoch: string; recordId: Buffer; baseVersion: string;
    cipherSuite: PersonalConnectionMeta['cipherSuite']; formatVersion: PersonalConnectionMeta['formatVersion'];
    nonce: Buffer; ciphertext: Buffer; tag: Buffer; newVersion: string; changeSequence: string;
  }): Promise<boolean> {
    const m = this.store.get(this.key(input.userId, input.keyEpoch, input.recordId));
    if (!m || m.deleteTime || m.version !== input.baseVersion) return false;
    m.cipherSuite = input.cipherSuite; m.formatVersion = input.formatVersion;
    m.nonce = input.nonce; m.ciphertext = input.ciphertext; m.tag = input.tag;
    m.version = input.newVersion; m.changeSequence = input.changeSequence; m.updateTime = new Date();
    return true;
  }

  async softDelete(_exec: Queryable, userId: number, keyEpoch: string, recordId: Buffer, baseVersion: string, newVersion: string, changeSequence: string, now: Date): Promise<boolean> {
    const m = this.store.get(this.key(userId, keyEpoch, recordId));
    if (!m || m.deleteTime || m.version !== baseVersion) return false;
    m.ciphertext = null; m.tag = null; m.version = newVersion; m.changeSequence = changeSequence; m.deleteTime = now; m.updateTime = new Date();
    return true;
  }

  async listByFeed(_exec: Queryable, userId: number, keyEpoch: string, after: string, snapshotSequence: string, limit: number): Promise<PersonalConnectionMeta[]> {
    const afterN = BigInt(after);
    const snapN = BigInt(snapshotSequence);
    return [...this.store.values()]
      .filter((m) => m.userId === userId && m.keyEpoch === keyEpoch
        && BigInt(m.changeSequence) > afterN && BigInt(m.changeSequence) <= snapN)
      .sort((a, b) => (BigInt(a.changeSequence) > BigInt(b.changeSequence) ? 1 : BigInt(a.changeSequence) < BigInt(b.changeSequence) ? -1 : 0))
      .slice(0, limit);
  }

  async countActive(_exec: Queryable, userId: number, keyEpoch: string): Promise<{ count: number; bytes: number }> {
    let count = 0; let bytes = 0;
    for (const m of this.store.values()) {
      if (m.userId === userId && m.keyEpoch === keyEpoch && !m.deleteTime) {
        count++;
        bytes += (m.ciphertext?.length ?? 0) + (m.tag?.length ?? 0) + (m.nonce?.length ?? 0);
      }
    }
    return { count, bytes };
  }

  async overview(_exec: Queryable, userId: number, keyEpoch: string): Promise<{ count: number; bytes: number; lastActivityTime: Date | null }> {
    let count = 0; let bytes = 0; let last: Date | null = null;
    for (const m of this.store.values()) {
      if (m.userId === userId && m.keyEpoch === keyEpoch && !m.deleteTime) {
        count++;
        bytes += (m.ciphertext?.length ?? 0) + (m.tag?.length ?? 0) + (m.nonce?.length ?? 0);
        if (!last || m.updateTime > last) last = m.updateTime;
      }
    }
    return { count, bytes, lastActivityTime: last };
  }

  async listActiveByEpoch(_exec: Queryable, userId: number, keyEpoch: string): Promise<PersonalConnectionMeta[]> {
    return [...this.store.values()]
      .filter((m) => m.userId === userId && m.keyEpoch === keyEpoch && !m.deleteTime)
      .sort((a, b) => (BigInt(a.changeSequence) > BigInt(b.changeSequence) ? 1 : -1));
  }
}

export class FakeSyncNonceRepo implements ISyncNonceRepo {
  private readonly seen = new Set<string>();

  async insert(_exec: Queryable, userId: number, keyEpoch: string, nonce: Buffer): Promise<boolean> {
    const k = `${userId}:${keyEpoch}:${nonce.toString('base64url')}`;
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }
}

export class FakeSyncMutationRepo implements ISyncMutationRepo {
  readonly store = new Map<string, SyncMutation>();

  private key(userId: number, keyEpoch: string, mutationId: Buffer): string {
    return `${userId}:${keyEpoch}:${mutationId.toString('base64url')}`;
  }

  async findByMutationId(_exec: Queryable, userId: number, keyEpoch: string, mutationId: Buffer): Promise<SyncMutation | undefined> {
    return this.store.get(this.key(userId, keyEpoch, mutationId));
  }

  async record(_exec: Queryable, input: {
    userId: number; keyEpoch: string; mutationId: Buffer; requestDigest: Buffer;
    action: SyncAction; resultVersion: string | null; resultChangeSequence: string | null;
    resultRecoveryCodeSetTime: Date | null;
    status: SyncMutationStatus; expiresTime: Date;
  }): Promise<void> {
    this.store.set(this.key(input.userId, input.keyEpoch, input.mutationId), {
      userId: input.userId, keyEpoch: input.keyEpoch, mutationId: input.mutationId, requestDigest: input.requestDigest,
      action: input.action, resultVersion: input.resultVersion, resultChangeSequence: input.resultChangeSequence,
      resultRecoveryCodeSetTime: input.resultRecoveryCodeSetTime,
      status: input.status, expiresTime: input.expiresTime, createTime: new Date(),
    });
  }

  async prune(_exec: Queryable, before: Date, limit: number): Promise<number> {
    let n = 0;
    for (const [k, m] of [...this.store]) {
      if (n >= limit) break;
      if (m.expiresTime < before) { this.store.delete(k); n++; }
    }
    return n;
  }
}

export class FakeSyncResetTokenRepo implements ISyncResetTokenRepo {
  readonly store = new Map<number, SyncResetToken>();

  async create(_exec: Queryable, input: { userId: number; tokenHash: Buffer; expiresTime: Date }): Promise<SyncResetToken> {
    const t: SyncResetToken = {
      id: nextId(), userId: input.userId, tokenHash: input.tokenHash,
      expiresTime: input.expiresTime, consumedTime: null, revokedTime: null, createTime: new Date(),
    };
    this.store.set(t.id, t);
    return t;
  }

  async revokePendingByUser(_exec: Queryable, userId: number, now: Date): Promise<void> {
    for (const t of this.store.values()) {
      if (t.userId === userId && !t.consumedTime && !t.revokedTime) t.revokedTime = now;
    }
  }

  async findUsableForUpdate(_exec: Queryable, tokenHash: Buffer): Promise<SyncResetToken | undefined> {
    for (const t of this.store.values()) {
      if (t.tokenHash.equals(tokenHash) && !t.consumedTime && !t.revokedTime && t.expiresTime > new Date()) return t;
    }
    return undefined;
  }

  async findByHash(tokenHash: Buffer): Promise<SyncResetToken | undefined> {
    for (const t of this.store.values()) {
      if (t.tokenHash.equals(tokenHash)) return t;
    }
    return undefined;
  }

  async findByIdForUpdate(_exec: Queryable, id: number): Promise<SyncResetToken | undefined> {
    return this.store.get(id);
  }

  async consume(_exec: Queryable, id: number, now: Date): Promise<boolean> {
    const t = this.store.get(id);
    if (!t || t.consumedTime || t.revokedTime) return false;
    t.consumedTime = now;
    return true;
  }

  async prune(_exec: Queryable, before: Date, limit: number): Promise<number> {
    let n = 0;
    for (const [id, t] of [...this.store]) {
      if (n >= limit) break;
      if (t.expiresTime < before || (t.consumedTime && t.consumedTime < before) || (t.revokedTime && t.revokedTime < before)) {
        this.store.delete(id); n++;
      }
    }
    return n;
  }
}

/** 内存 sync-reset handoff 假实现：以 ticketHash hex 为键。 */
export class FakeSyncResetHandoffRepo implements ISyncResetHandoffRepo {
  readonly store = new Map<string, SyncResetHandoff>();

  async create(_exec: Queryable, input: { userId: number; resetTokenId: number; ticketHash: Buffer; expiresTime: Date }): Promise<SyncResetHandoff> {
    const h: SyncResetHandoff = {
      id: nextId(), userId: input.userId, resetTokenId: input.resetTokenId,
      ticketHash: input.ticketHash, requestDigest: null, resultStateDtoJson: null,
      resultKeyEpoch: null, resultStateVersion: null, resultChangeSequence: null,
      status: 'issued' as SyncResetHandoffStatus, expiresTime: input.expiresTime,
      consumedTime: null, createTime: new Date(), updateTime: new Date(),
    };
    this.store.set(input.ticketHash.toString('hex'), h);
    return h;
  }

  async findByTicketHash(ticketHash: Buffer): Promise<SyncResetHandoff | undefined> {
    return this.store.get(ticketHash.toString('hex'));
  }

  async findByTicketHashForUpdate(_exec: Queryable, ticketHash: Buffer): Promise<SyncResetHandoff | undefined> {
    return this.store.get(ticketHash.toString('hex'));
  }

  async revokePendingByResetToken(_exec: Queryable, resetTokenId: number, now: Date): Promise<void> {
    for (const h of this.store.values()) {
      if (h.resetTokenId === resetTokenId && (h.status === 'issued' || h.status === 'processing')) {
        h.status = 'revoked'; h.updateTime = now;
      }
    }
  }

  async markProcessing(_exec: Queryable, id: number, requestDigest: Buffer, now: Date): Promise<void> {
    for (const h of this.store.values()) if (h.id === id) { h.status = 'processing'; h.requestDigest = requestDigest; h.updateTime = now; }
  }

  async markCompleted(_exec: Queryable, id: number, now: Date, result: { stateDtoJson: string; keyEpoch: string; stateVersion: string; changeSequence: string }): Promise<void> {
    for (const h of this.store.values()) {
      if (h.id === id) {
        h.status = 'completed'; h.consumedTime = now; h.updateTime = now;
        h.resultStateDtoJson = result.stateDtoJson;
        h.resultKeyEpoch = result.keyEpoch;
        h.resultStateVersion = result.stateVersion;
        h.resultChangeSequence = result.changeSequence;
      }
    }
  }

  async rollbackProcessing(_exec: Queryable, id: number, now: Date): Promise<void> {
    for (const h of this.store.values()) {
      if (h.id === id && h.status === 'processing') { h.status = 'issued'; h.requestDigest = null; h.updateTime = now; }
    }
  }

  async expire(_exec: Queryable, now: Date, limit: number): Promise<number> {
    let n = 0;
    for (const h of this.store.values()) {
      if (n >= limit) break;
      if ((h.status === 'issued' || h.status === 'processing') && h.expiresTime < now) {
        h.status = 'expired'; h.updateTime = now; n++;
      }
    }
    return n;
  }

  async prune(_exec: Queryable, before: Date, limit: number): Promise<number> {
    let n = 0;
    for (const [k, h] of [...this.store]) {
      if (n >= limit) break;
      if ((h.status === 'completed' || h.status === 'revoked' || h.status === 'expired') && h.updateTime < before) {
        this.store.delete(k); n++;
      }
    }
    return n;
  }
}

/** 内存幂等回执假实现：唯一键 + ER_DUP_ENTRY 语义。 */
export class FakeIdempotencyReceiptRepo implements IIdempotencyReceiptRepo {
  readonly store = new Map<string, IdempotencyReceipt>();

  private key(actorUserId: number, sessionId: string, method: string, normalizedPath: string, idempotencyKey: string): string {
    return `${actorUserId}|${sessionId}|${method}|${normalizedPath}|${idempotencyKey}`;
  }

  async createProcessing(_exec: Queryable, input: {
    actorUserId: number; sessionId: string; method: string; normalizedPath: string;
    idempotencyKey: string; requestDigest: Buffer; expiresTime: Date;
  }): Promise<IdempotencyReceipt> {
    const k = this.key(input.actorUserId, input.sessionId, input.method, input.normalizedPath, input.idempotencyKey);
    if (this.store.has(k)) {
      const err = new Error('duplicate key') as Error & { code: string };
      err.code = 'ER_DUP_ENTRY';
      throw err;
    }
    const receipt: IdempotencyReceipt = {
      id: this.store.size + 1,
      actorUserId: input.actorUserId,
      sessionId: input.sessionId,
      method: input.method,
      normalizedPath: input.normalizedPath,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      status: 'processing',
      httpStatus: null,
      responseBody: null,
      expiresTime: input.expiresTime,
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(k, receipt);
    return receipt;
  }

  async findByKey(actorUserId: number, sessionId: string, method: string, normalizedPath: string, idempotencyKey: string): Promise<IdempotencyReceipt | undefined> {
    return this.store.get(this.key(actorUserId, sessionId, method, normalizedPath, idempotencyKey));
  }

  async complete(_exec: Queryable, id: number, httpStatus: number, responseBody: string): Promise<void> {
    for (const r of this.store.values()) {
      if (r.id === id) {
        r.status = 'completed';
        r.httpStatus = httpStatus;
        r.responseBody = responseBody;
        r.updateTime = new Date();
      }
    }
  }

  async prune(_exec: Queryable, before: Date, limit: number): Promise<number> {
    let n = 0;
    for (const [k, r] of [...this.store]) {
      if (n >= limit) break;
      if (r.expiresTime < before) { this.store.delete(k); n++; }
    }
    return n;
  }
}
