import type {
  IUserRepo,
  IEmailVerificationTokenRepo,
  IPersonalSubscriptionRepo,
  IDeviceRepo,
  IRefreshTokenRepo,
  IRateLimitRepo,
  IRegistrationRepo,
  IPlanRepo,
  IPlanFeatureDefRepo,
  ISyncStateRepo,
  ISyncRecordRepo,
  ISyncNonceRepo,
  ISyncMutationRepo,
  ISyncResetTokenRepo,
  ISyncResetHandoffRepo,
  IIdempotencyReceiptRepo,
  RegistrationAccountInput,
  RegistrationResult,
  AdminUserFilter,
  AdminUserRow,
} from '../../src/repository/interfaces.js';
import type {
  User,
  EmailVerificationToken,
  Plan,
  PlanFeatureDef,
  PersonalSubscription,
  Device,
  RefreshToken,
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

export function makeFreePlan(id = nextId()): Plan {
  return makePlan({ id, code: 'free', kind: 'personal', name: 'Free', priceCents: 0, billingUnit: 'month', features: {
    allowedDatabaseTypes: ['mysql', 'sqlite', 'redis'],
    maxDevices: 0,
    maxConnectionMetas: 500,
    syncStorageBytes: 33554432,
    maxSavedConnections: 10,
    allowConnectionImport: false,
  } });
}

export function makeProPlan(id = nextId()): Plan {
  return makePlan({ id, code: 'pro', kind: 'personal', name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 20, features: {
    allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite', 'redis'],
    maxDevices: 0,
    maxConnectionMetas: 5000,
    syncStorageBytes: 268435456,
    maxSavedConnections: 100,
    allowConnectionImport: true,
  } });
}

export function makePlan(overrides: Partial<Plan> & { code: string; kind: Plan['kind']; features: Record<string, unknown> }): Plan {
  return {
    id: nextId(),
    name: overrides.code,
    priceCents: 0,
    billingUnit: 'month',
    sortOrder: 0,
    status: 'active',
    version: 1,
    createTime: new Date(),
    updateTime: new Date(),
    ...overrides,
  };
}

/** 默认套餐集：与 baseline 种子一致（free/pro）。 */
export function defaultPlans(): Plan[] {
  return [
    makeFreePlan(),
    makeProPlan(),
  ];
}

export class FakePlanRepo implements IPlanRepo {
  constructor(public plans: Plan[] = defaultPlans()) {}

  async findByCode(code: string): Promise<Plan | undefined> {
    return this.plans.find((p) => p.code === code);
  }

  async findById(id: number): Promise<Plan | undefined> {
    return this.plans.find((p) => p.id === id);
  }

  async findByCodeInTx(_exec: Queryable, code: string): Promise<Plan | undefined> {
    return this.findByCode(code);
  }

  async findByIdInTx(_exec: Queryable, id: number): Promise<Plan | undefined> {
    return this.findById(id);
  }

  async listActive(): Promise<Plan[]> {
    return this.plans.filter((p) => p.status === 'active');
  }

  async listAll(): Promise<Plan[]> {
    return [...this.plans];
  }

  invalidate(): void { /* in-memory: nothing to invalidate */ }

  async saveInTx(_exec: Queryable, input: {
    id: number; name: string; priceCents: number; billingUnit: Plan['billingUnit'];
    sortOrder: number; status: Plan['status'];
    features: ReadonlyArray<{ featureKey: string; value: unknown }>;
    expectedVersion: number;
  }): Promise<boolean> {
    const plan = this.plans.find((p) => p.id === input.id);
    if (!plan || plan.version !== input.expectedVersion) return false;
    Object.assign(plan, {
      name: input.name, priceCents: input.priceCents, billingUnit: input.billingUnit,
      sortOrder: input.sortOrder, status: input.status,
      features: Object.fromEntries(input.features.map((f) => [f.featureKey, f.value])),
    });
    plan.version += 1;
    return true;
  }
}

export class FakePlanFeatureDefRepo implements IPlanFeatureDefRepo {
  constructor(public defs: PlanFeatureDef[] = []) {}

  async listAll(): Promise<PlanFeatureDef[]> {
    return [...this.defs];
  }

  async findByKey(key: string): Promise<PlanFeatureDef | undefined> {
    return this.defs.find((d) => d.key === key);
  }

  async findByKeyInTx(_exec: Queryable, key: string): Promise<PlanFeatureDef | undefined> {
    return this.defs.find((d) => d.key === key);
  }

  async upsertInTx(_exec: Queryable, input: {
    key: string; kind: PlanFeatureDef['kind']; label: PlanFeatureDef['label'];
    valueType: PlanFeatureDef['valueType']; unit: string | null; sortOrder: number;
  }): Promise<void> {
    const existing = this.defs.find((d) => d.key === input.key);
    if (existing) Object.assign(existing, input);
    else this.defs.push({ id: nextId(), ...input });
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
    periodEndTime: Date | null;
    expectedVersion: number;
  }): Promise<boolean> {
    const s = this.store.get(input.id);
    if (!s || s.version !== input.expectedVersion) return false;
    s.planId = input.planId;
    s.status = input.status;
    s.periodEndTime = input.periodEndTime;
    s.version += 1;
    return true;
  }

  async create(input: {
    userId: number;
    planId: number;
    status: PersonalSubscription['status'];
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<PersonalSubscription> {
    const s: PersonalSubscription = {
      id: nextId(),
      userId: input.userId,
      planId: input.planId,
      status: input.status,
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
    expiresTime: Date;
  }): Promise<RefreshToken> {
    const t: RefreshToken = {
      id: nextId(),
      userId: input.userId,
      deviceId: input.deviceId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
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
    private readonly plans: IPlanRepo,
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
    await this.subs.create({
      userId: user.id,
      planId: freePlan.id,
      status: 'active',
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
    entityKind?: string | null;
  }): Promise<PersonalConnectionMeta> {
    const meta: PersonalConnectionMeta = {
      id: nextId(),
      userId: input.userId, keyEpoch: input.keyEpoch, recordId: input.recordId,
      cipherSuite: input.cipherSuite, formatVersion: input.formatVersion,
      nonce: input.nonce, ciphertext: input.ciphertext, tag: input.tag,
      entityKind: input.entityKind ?? null,
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
    entityKind?: string | null;
  }): Promise<boolean> {
    const m = this.store.get(this.key(input.userId, input.keyEpoch, input.recordId));
    if (!m || m.deleteTime || m.version !== input.baseVersion) return false;
    m.cipherSuite = input.cipherSuite; m.formatVersion = input.formatVersion;
    m.nonce = input.nonce; m.ciphertext = input.ciphertext; m.tag = input.tag;
    if (input.entityKind != null) m.entityKind = input.entityKind;
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

  async overviewByKind(_exec: Queryable, userId: number, keyEpoch: string): Promise<Array<{ entityKind: string | null; count: number; bytes: number; lastActivityTime: Date | null }>> {
    const acc = new Map<string | null, { entityKind: string | null; count: number; bytes: number; lastActivityTime: Date | null }>();
    for (const m of this.store.values()) {
      if (m.userId !== userId || m.keyEpoch !== keyEpoch || m.deleteTime) continue;
      const k = m.entityKind ?? null;
      const cur = acc.get(k) ?? { entityKind: k, count: 0, bytes: 0, lastActivityTime: null };
      cur.count += 1;
      cur.bytes += (m.ciphertext?.length ?? 0) + (m.tag?.length ?? 0) + (m.nonce?.length ?? 0);
      if (!cur.lastActivityTime || m.updateTime > cur.lastActivityTime) cur.lastActivityTime = m.updateTime;
      acc.set(k, cur);
    }
    return [...acc.values()];
  }

  async countActiveByKind(_exec: Queryable, userId: number, keyEpoch: string, entityKind: string): Promise<number> {
    let n = 0;
    for (const m of this.store.values()) {
      if (m.userId === userId && m.keyEpoch === keyEpoch && !m.deleteTime && m.entityKind === entityKind) n++;
    }
    return n;
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
