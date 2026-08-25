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
  IAdminAuditRepo,
  AdminAuditInput,
  IWebhookEventRepo,
  AllowlistRow,
  RateLimitRuleRow,
  TrafficBlockedRow,
  TrafficStatRow,
  ConnectionMetaInput,
  PlanEditableFields,
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
  DeviceEvent,
  ConnectionMeta,
  SyncEvent,
  UsageEvent,
} from '../../src/domain/entities.js';
import type { PlanCode, Role, SubStatus, SectionType, UserStatus } from '../../src/domain/enums.js';
import { EXPIRABLE_STATUSES } from '../../src/domain/enums.js';
import { ConflictError, VersionNotFoundError } from '../../src/domain/errors.js';

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
    maxOpenConnections: 0,
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

  /** 只数 active 的 admin：被禁用的 admin 登不进来，不能算作「还有人能管」 */
  async countAdmins(): Promise<number> {
    let n = 0;
    for (const u of this.users.values()) if (u.role === 'admin' && u.status === 'active') n += 1;
    return n;
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
  /** downgradeExpired 的调用次数（断言 ensureActive 不再触发全表批量降级） */
  downgradeCalls = 0;
  /** expireOne 的调用次数 */
  expireOneCalls = 0;

  /**
   * 真实现的 expireOne / downgradeExpired 都是一条语句改 subscriptions + users
   * 两张表。fake 拿不到 users 就只能改自己那半边 —— 此前它改的是
   * `subscriptions.plan_code`，一个真实现根本不碰的列，于是「用户有没有被降到
   * free」这条核心不变量在单测里从未被验证过。链上 userRepo 才能忠实复刻。
   */
  private users?: FakeUserRepo;

  linkUsers(userRepo: FakeUserRepo): void {
    this.users = userRepo;
  }

  /** 置为 true 让下一次 upsert 抛错，用来测「处理失败时不记幂等」 */
  failNextUpsert = false;

  /** findByUserId 调用次数（断言 listUsers 不再走 N+1） */
  findByUserIdCalls = 0;
  /** findByUserIds 调用次数 */
  findByUserIdsCalls = 0;

  async findByUserId(userId: number): Promise<Subscription | undefined> {
    this.findByUserIdCalls++;
    for (const s of this.subs.values()) if (s.userId === userId) return s;
    return undefined;
  }

  async findByUserIds(userIds: number[]): Promise<Subscription[]> {
    this.findByUserIdsCalls++;
    // 真实现空数组时提前返回（IN () 是语法错误），这里复刻同样的语义
    if (userIds.length === 0) return [];
    const wanted = new Set(userIds);
    return [...this.subs.values()].filter((s) => wanted.has(s.userId));
  }

  async upsert(
    sub: Omit<Subscription, 'id' | 'createTime' | 'updateTime'> & { id?: number },
  ): Promise<Subscription> {
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      throw new Error('simulated upsert failure');
    }
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

  /**
   * 复刻真实现：只改这一个用户，status → expired 且 users.plan_code → free。
   * 可降级状态取共享常量 —— fake 里硬编码 'active' 会把 trialing/canceled
   * 的处理遮住（真实现改了，fake 没改，测试照样绿）。
   */
  async expireOne(userId: number, now: Date): Promise<boolean> {
    this.expireOneCalls++;
    for (const s of this.subs.values()) {
      if (s.userId === userId && EXPIRABLE_STATUSES.includes(s.status) && s.periodEndTime <= now) {
        s.status = 'expired';
        await this.users?.updatePlan(userId, 'free');
        return true;
      }
    }
    return false;
  }

  /**
   * 复刻真实现：改 users.plan_code（不是 subscriptions.plan_code），
   * 返回**订阅行数**。边界与 expireOne 统一用 `<=`。
   */
  async downgradeExpired(now: Date): Promise<number> {
    this.downgradeCalls++;
    let n = 0;
    for (const s of this.subs.values()) {
      if (EXPIRABLE_STATUSES.includes(s.status) && s.periodEndTime <= now) {
        s.status = 'expired';
        await this.users?.updatePlan(s.userId, 'free');
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
      result = { ...device, id: ++this.seq, createTime: now, updateTime: now, revokedTime: new Date() };
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

  /**
   * 复刻真实现的**全量替换**语义：upsert 入参 + 把未上报的现存行置墓碑。
   *
   * 原来这里和真实现一样只做 upsert（fake 忠实复刻了缺陷），所以
   * 「replaceAll 不删除」这个绕过路径在测试里结构性不可见。返回值同样改为
   * 取库内真值而非入参推算。
   */
  async replaceAll(userId: number, metas: ConnectionMetaInput[]): Promise<number> {
    const now = new Date();
    const seen = new Set(metas.map((m) => m.connUuid));
    for (const m of metas) {
      const k = `${userId}:${m.connUuid}`;
      const existing = this.metas.get(k);
      this.metas.set(k, {
        ...m, id: existing?.id ?? ++this.seq, userId,
        createTime: existing?.createTime ?? now, updateTime: now,
      });
    }
    // 本次未上报的行 → 墓碑
    for (const [k, m] of this.metas) {
      if (m.userId === userId && !m.deleted && !seen.has(m.connUuid)) {
        this.metas.set(k, { ...m, deleted: true, updateTime: now });
      }
    }
    return this.countActive(userId);
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

/**
 * 内存审计仓储。
 *
 * `failNext` 用来测「留痕写不进去时管理操作必须一起失败」—— 这条不变量
 * 没法用真实故障触发，只能注入。
 */
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

  async seen(provider: string, eventKey: string): Promise<boolean> {
    return this.rows.has(`${provider}:${eventKey}`);
  }

  async record(provider: string, eventKey: string, detail?: Record<string, unknown>): Promise<boolean> {
    const k = `${provider}:${eventKey}`;
    if (this.rows.has(k)) return false;
    this.rows.set(k, detail);
    return true;
  }
}

function key(userId: number, section: SectionType): string {
  return `${userId}:${section}`;
}
