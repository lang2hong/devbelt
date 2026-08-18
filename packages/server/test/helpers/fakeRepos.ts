import type {
  IUserRepo,
  IPlanRepo,
  ISubscriptionRepo,
  IRefreshTokenRepo,
  ISyncRepo,
  IDeviceRepo,
  IConnectionMetaRepo,
  ISyncEventRepo,
  IUsageEventRepo,
  ITrafficRepo,
  IRateLimitRepo,
  AllowlistRow,
  RateLimitRuleRow,
  TrafficBlockedRow,
  TrafficStatRow,
  ConnectionMetaInput,
  PlanEditableFields,
} from '../../src/repository/interfaces.js';
import type {
  User,
  Plan,
  Subscription,
  RefreshToken,
  SyncSection,
  SyncSectionVersion,
  SyncVersionSummary,
  SessionInfo,
  Device,
  DeviceEvent,
  ConnectionMeta,
  SyncEvent,
  UsageEvent,
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

  async count(): Promise<number> {
    return this.users.size;
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

  async update(code: PlanCode, fields: PlanEditableFields): Promise<void> {
    const p = this.plans.get(code);
    if (p) Object.assign(p, fields);
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

  async listAll(): Promise<Subscription[]> {
    return [...this.subs.values()];
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

export class FakeDeviceRepo implements IDeviceRepo {
  readonly devices = new Map<string, Device>();
  readonly events = new Map<string, DeviceEvent[]>();
  private seq = 0;
  private eventSeq = 0;

  async upsert(device: Omit<Device, 'id' | 'createTime' | 'updateTime'>): Promise<Device> {
    const k = `${device.userId}:${device.deviceId}`;
    const now = new Date();
    const existing = this.devices.get(k);
    let result: Device;
    if (existing) {
      result = { ...existing, ...device, id: existing.id, updateTime: now };
    } else {
      result = { ...device, id: ++this.seq, createTime: now, updateTime: now };
    }
    this.devices.set(k, result);

    // 留痕（简化）：首次 → register；app 版本变 → app_upgrade；否则 os 版本变 → os_change
    let event: DeviceEvent['event'] | undefined;
    if (!existing) event = 'register';
    else if (result.appVersion && result.appVersion !== existing.appVersion) event = 'app_upgrade';
    else if (result.osVersion && result.osVersion !== existing.osVersion) event = 'os_change';
    if (event) {
      const list = this.events.get(k) ?? [];
      list.push({
        id: ++this.eventSeq, userId: result.userId, deviceId: result.deviceId, event,
        vsMachineId: result.vsMachineId, appName: result.appName, appVersion: result.appVersion,
        os: result.os, osVersion: result.osVersion, arch: result.arch, createTime: now,
      });
      this.events.set(k, list);
    }

    return result;
  }

  async listByUser(userId: number): Promise<Device[]> {
    return [...this.devices.values()].filter((d) => d.userId === userId);
  }

  async listEvents(userId: number, deviceId: string): Promise<DeviceEvent[]> {
    return this.events.get(`${userId}:${deviceId}`) ?? [];
  }
}

export class FakeConnectionMetaRepo implements IConnectionMetaRepo {
  readonly metas = new Map<string, ConnectionMeta>();
  private seq = 0;

  async replaceAll(userId: number, metas: ConnectionMetaInput[]): Promise<number> {
    const active = metas.filter((m) => !m.deleted).length;
    const now = new Date();
    for (const m of metas) {
      const k = `${userId}:${m.connUuid}`;
      const existing = this.metas.get(k);
      this.metas.set(k, {
        ...m, id: existing?.id ?? ++this.seq, userId,
        createTime: existing?.createTime ?? now, updateTime: now,
      });
    }
    return active;
  }

  async countActive(userId: number): Promise<number> {
    let n = 0;
    for (const m of this.metas.values()) if (m.userId === userId && !m.deleted) n++;
    return n;
  }

  async listByUser(userId: number): Promise<ConnectionMeta[]> {
    return [...this.metas.values()].filter((m) => m.userId === userId);
  }
}

export class FakeSyncEventRepo implements ISyncEventRepo {
  readonly events: SyncEvent[] = [];
  private seq = 0;

  async record(event: Omit<SyncEvent, 'id' | 'createTime'>): Promise<void> {
    this.events.push({ ...event, id: ++this.seq, createTime: new Date() });
  }

  async listByUser(userId: number, limit = 100): Promise<SyncEvent[]> {
    return this.events.filter((e) => e.userId === userId).slice(-limit).reverse();
  }
}

export class FakeUsageEventRepo implements IUsageEventRepo {
  readonly events: UsageEvent[] = [];
  private seq = 0;

  async record(userId: number, deviceId: string | undefined, kind: UsageEvent['kind'], count: number): Promise<void> {
    this.events.push({ id: ++this.seq, userId, deviceId, kind, count, createTime: new Date() });
  }

  async listByUser(userId: number, limit = 200): Promise<UsageEvent[]> {
    return this.events.filter((e) => e.userId === userId).slice(-limit).reverse();
  }
}

/**
 * 流量仓储假实现。
 *
 * `upsertStats` 复刻真实现的 `count = count + VALUES(count)` 语义（累加而非
 * 覆盖）—— 采集器每分钟 flush 一次同一个小时桶，写成覆盖的话会丢掉前面
 * 几十次的计数，那是个很容易犯又很难看出来的错。
 */
export class FakeTrafficRepo implements ITrafficRepo {
  readonly stats = new Map<string, TrafficStatRow>();
  readonly blocked: TrafficBlockedRow[] = [];
  /** 置为 true 让写入抛错，用来测 flush 失败后的数据回滚 */
  failWrites = false;

  async upsertStats(rows: TrafficStatRow[]): Promise<void> {
    if (this.failWrites) throw new Error('simulated stats write failure');
    for (const r of rows) {
      const k = `${r.bucketTime.getTime()}|${r.route}|${r.statusClass}`;
      const existing = this.stats.get(k);
      if (existing) existing.count += r.count;
      else this.stats.set(k, { ...r });
    }
  }

  async queryStats(from: Date, to: Date): Promise<TrafficStatRow[]> {
    return [...this.stats.values()]
      .filter((r) => r.bucketTime >= from && r.bucketTime <= to)
      .sort((a, b) => a.bucketTime.getTime() - b.bucketTime.getTime());
  }

  async insertBlocked(rows: Array<Omit<TrafficBlockedRow, 'createTime'>>): Promise<void> {
    if (this.failWrites) throw new Error('simulated blocked write failure');
    for (const r of rows) this.blocked.push({ ...r, createTime: new Date() });
  }

  async queryBlocked(from: Date, to: Date, limit: number): Promise<TrafficBlockedRow[]> {
    return this.blocked
      .filter((r) => r.createTime >= from && r.createTime <= to)
      .slice(-limit)
      .reverse();
  }
}

export class FakeRateLimitRepo implements IRateLimitRepo {
  readonly rules = new Map<string, RateLimitRuleRow>();
  readonly allowlist = new Map<string, AllowlistRow>();
  /** 置为 true 让读取抛错，用来测「DB 挂了限流仍按默认值工作」 */
  failReads = false;

  async listRules(): Promise<RateLimitRuleRow[]> {
    if (this.failReads) throw new Error('simulated rules read failure');
    return [...this.rules.values()];
  }

  async upsertRule(rule: RateLimitRuleRow): Promise<void> {
    this.rules.set(rule.bucket, { ...rule });
  }

  async listAllowlist(): Promise<AllowlistRow[]> {
    if (this.failReads) throw new Error('simulated allowlist read failure');
    return [...this.allowlist.values()];
  }

  async addAllowlist(ip: string, note?: string): Promise<void> {
    this.allowlist.set(ip, { ip, note, createTime: new Date() });
  }

  async removeAllowlist(ip: string): Promise<void> {
    this.allowlist.delete(ip);
  }
}

function key(userId: number, section: SectionType): string {
  return `${userId}:${section}`;
}
