import type {
  IUserRepo,
  IPlanRepo,
  ISubscriptionRepo,
  IRefreshTokenRepo,
  IPatRepo,
  ISyncRepo,
} from '../../src/repository/interfaces.js';
import type {
  User,
  Plan,
  Subscription,
  RefreshToken,
  Pat,
  SyncSection,
  SyncSectionVersion,
  SyncVersionSummary,
  SessionInfo,
} from '../../src/domain/entities.js';
import type { PlanCode, Role, SubStatus, SectionType, UserStatus } from '../../src/domain/enums.js';

/**
 * 内存假仓储：service/policy 层单测用。
 * 只保证被测服务依赖的语义（乐观锁、撤销、配额计数），不追求 SQL 实现的全部细节。
 */

export function makePlan(code: PlanCode, over: Partial<Plan> = {}): Plan {
  const now = new Date();
  return {
    code,
    name: code,
    priceMonth: 0,
    priceYear: 0,
    maxDevices: 0,
    maxConnections: 0,
    syncQuotaBytes: 0,
    syncVersionRetention: 0,
    historyRetentionCount: 0,
    maxPats: 0,
    features: 1,
    createTime: now,
    updateTime: now,
    ...over,
  };
}

export class FakeUserRepo implements IUserRepo {
  readonly users = new Map<number, User>();
  private seq = 0;

  async findById(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async findByEmail(email: string): Promise<User | undefined> {
    for (const u of this.users.values()) if (u.email === email) return u;
    return undefined;
  }

  async create(email: string, passwordHash: string, role: Role, planCode: PlanCode): Promise<User> {
    const now = new Date();
    const user: User = {
      id: ++this.seq,
      email,
      passwordHash,
      role,
      status: 'active',
      planCode,
      createTime: now,
      updateTime: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  async updateLastLogin(id: number, time: Date): Promise<void> {
    const u = this.users.get(id);
    if (u) u.lastLoginTime = time;
  }

  async updatePlan(id: number, planCode: PlanCode): Promise<void> {
    const u = this.users.get(id);
    if (u) u.planCode = planCode;
  }

  async updateRole(id: number, role: Role): Promise<void> {
    const u = this.users.get(id);
    if (u) u.role = role;
  }

  async updatePassword(id: number, passwordHash: string): Promise<void> {
    const u = this.users.get(id);
    if (u) u.passwordHash = passwordHash;
  }

  async updateStatus(id: number, status: UserStatus): Promise<void> {
    const u = this.users.get(id);
    if (u) u.status = status;
  }

  async listAll(limit: number, offset: number): Promise<User[]> {
    return [...this.users.values()].slice(offset, offset + limit);
  }
}

export class FakePlanRepo implements IPlanRepo {
  readonly plans = new Map<PlanCode, Plan>();

  constructor(plans: Plan[] = []) {
    for (const p of plans) this.plans.set(p.code, p);
  }

  async findByCode(code: PlanCode): Promise<Plan | undefined> {
    return this.plans.get(code);
  }

  async listAll(): Promise<Plan[]> {
    return [...this.plans.values()];
  }

  async seed(plans: Array<Omit<Plan, 'createTime' | 'updateTime'>>): Promise<void> {
    const now = new Date();
    for (const p of plans) this.plans.set(p.code, { ...p, createTime: now, updateTime: now });
  }
}

export class FakeSubscriptionRepo implements ISubscriptionRepo {
  readonly subs = new Map<number, Subscription>();
  private seq = 0;
  /** downgradeExpired 的调用次数（断言 ensureActive 是否触发批量降级） */
  downgradeCalls = 0;

  async findByUserId(userId: number): Promise<Subscription | undefined> {
    for (const s of this.subs.values()) if (s.userId === userId) return s;
    return undefined;
  }

  async upsert(
    sub: Omit<Subscription, 'id' | 'createTime' | 'updateTime'> & { id?: number },
  ): Promise<Subscription> {
    const now = new Date();
    const existing = sub.id !== undefined
      ? this.subs.get(sub.id)
      : await this.findByUserId(sub.userId);
    if (existing) {
      const merged: Subscription = { ...existing, ...sub, id: existing.id, updateTime: now };
      this.subs.set(existing.id, merged);
      return merged;
    }
    const created: Subscription = { ...sub, id: ++this.seq, createTime: now, updateTime: now };
    this.subs.set(created.id, created);
    return created;
  }

  async listByStatus(status: SubStatus): Promise<Subscription[]> {
    return [...this.subs.values()].filter((s) => s.status === status);
  }

  async downgradeExpired(now: Date): Promise<number> {
    this.downgradeCalls++;
    let n = 0;
    for (const s of this.subs.values()) {
      if (s.status === 'active' && s.periodEndTime <= now) {
        s.status = 'expired';
        s.planCode = 'free';
        n++;
      }
    }
    return n;
  }
}

export class FakeRefreshTokenRepo implements IRefreshTokenRepo {
  readonly tokens = new Map<number, RefreshToken>();
  private seq = 0;

  async create(token: Omit<RefreshToken, 'id' | 'createTime'>): Promise<RefreshToken> {
    const created: RefreshToken = { ...token, id: ++this.seq, createTime: new Date() };
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

  async revokeAllForUser(userId: number): Promise<void> {
    const now = new Date();
    for (const t of this.tokens.values()) {
      if (t.userId === userId && !t.revokedTime) t.revokedTime = now;
    }
  }

  async countActiveForUser(userId: number, now: Date): Promise<number> {
    return this.activeFor(userId, now).length;
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

  async updateLastUsed(id: number, time: Date): Promise<void> {
    const t = this.tokens.get(id);
    if (t) t.lastUsedTime = time;
  }

  private activeFor(userId: number, now: Date): RefreshToken[] {
    return [...this.tokens.values()].filter(
      (t) => t.userId === userId && !t.revokedTime && t.expiresTime > now,
    );
  }
}

export class FakePatRepo implements IPatRepo {
  readonly pats = new Map<number, Pat>();
  private seq = 0;

  async create(pat: Omit<Pat, 'id' | 'createTime'>): Promise<Pat> {
    const created: Pat = { ...pat, id: ++this.seq, createTime: new Date() };
    this.pats.set(created.id, created);
    return created;
  }

  async findByHash(hash: string): Promise<Pat | undefined> {
    for (const p of this.pats.values()) if (p.tokenHash === hash) return p;
    return undefined;
  }

  async findById(id: number): Promise<Pat | undefined> {
    return this.pats.get(id);
  }

  async listByUser(userId: number): Promise<Pat[]> {
    return [...this.pats.values()].filter((p) => p.userId === userId);
  }

  async revoke(id: number): Promise<void> {
    const p = this.pats.get(id);
    if (p && !p.revokedTime) p.revokedTime = new Date();
  }

  async countActiveForUser(userId: number): Promise<number> {
    return [...this.pats.values()].filter((p) => p.userId === userId && !p.revokedTime).length;
  }

  async updateLastUsed(id: number, time: Date): Promise<void> {
    const p = this.pats.get(id);
    if (p) p.lastUsedTime = time;
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
    this.current.set(key(userId, section), {
      userId,
      section,
      encryptedData,
      version,
      updateTime: new Date(),
    });
    return version;
  }

  async putSectionIfVersion(
    userId: number,
    section: SectionType,
    encryptedData: string,
    baseVersion: number,
  ): Promise<number | null> {
    const cur = this.current.get(key(userId, section));
    const curVersion = cur ? cur.version : 0;
    if (curVersion !== baseVersion) return null;
    return this.putSection(userId, section, encryptedData, curVersion + 1);
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
    list.push({
      id: ++this.seq,
      userId,
      section,
      version,
      encryptedData,
      dataBytes,
      createTime: new Date(),
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

  async rollback(userId: number, section: SectionType, toVersion: number): Promise<number> {
    const target = await this.getVersion(userId, section, toVersion);
    if (!target) throw new Error(`version not found: ${toVersion}`);
    const cur = this.current.get(key(userId, section));
    const next = (cur ? cur.version : 0) + 1;
    await this.putSection(userId, section, target.encryptedData, next);
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

function key(userId: number, section: SectionType): string {
  return `${userId}:${section}`;
}
