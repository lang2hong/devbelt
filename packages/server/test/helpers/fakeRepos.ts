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
  MemberDto,
  OrganizationSummary,
  InvitationDto,
  RegistrationAccountInput,
  RegistrationResult,
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
} from '../../src/domain/entities.js';
import type {
  UserStatus,
  EmailVerificationPurpose,
  OrganizationRole,
  OrganizationMembershipStatus,
  OrganizationSubscriptionStatus,
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

  async create(email: string, passwordHash: string, displayName?: string): Promise<User> {
    if (this.emailIndex.has(email)) throw new ConflictError(`user already exists: ${email}`);
    const user: User = {
      id: nextId(),
      email,
      emailVerifiedTime: null,
      passwordHash,
      displayName,
      status: 'active',
      lastLoginTime: null,
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

  async markEmailVerified(_exec: Queryable, id: number, time: Date): Promise<void> {
    const u = this.store.get(id);
    if (u) u.emailVerifiedTime = time;
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
}

export function makeFreePlan(id = nextId()): PersonalPlan {
  return {
    id,
    code: 'free',
    name: 'Free',
    allowedDatabaseTypes: ['mysql', 'sqlite'],
    maxDevices: 0,
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
}

export class FakePersonalSubscriptionRepo implements IPersonalSubscriptionRepo {
  readonly store = new Map<number, PersonalSubscription>();

  async findByUserId(userId: number): Promise<PersonalSubscription | undefined> {
    for (const s of this.store.values()) if (s.userId === userId) return s;
    return undefined;
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
    return [...this.store.values()].filter((d) => d.userId === userId && d.status === 'active').length;
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
      createTime: new Date(),
      updateTime: new Date(),
    };
    this.store.set(s.id, s);
    return s;
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
        if (this.membershipRepo) await this.membershipRepo.remove({} as Queryable, i.membershipId, now);
      }
    }
  }
}
