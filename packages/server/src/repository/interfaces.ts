import type { PlanCode, Role, SubStatus, SectionType, UserStatus } from '../domain/enums.js';
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
} from '../domain/entities.js';

/**
 * 数据访问层接口（Repository 模式）。
 * 接口与实现分离：domain/service 仅依赖接口，不依赖具体 DB 驱动。
 * 当前唯一实现为 mysql/，后续可加 postgres/sqlite 实现。
 */

export interface IUserRepo {
  findById(id: number): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  create(email: string, passwordHash: string, role: Role, planCode: PlanCode): Promise<User>;
  updateLastLogin(id: number, time: Date): Promise<void>;
  updatePlan(id: number, planCode: PlanCode): Promise<void>;
  updateRole(id: number, role: Role): Promise<void>;
  updatePassword(id: number, passwordHash: string): Promise<void>;
  updateStatus(id: number, status: UserStatus): Promise<void>;
  listAll(limit: number, offset: number): Promise<User[]>;
  count(): Promise<number>;
}

/** 套餐可编辑字段（管理后台编辑套餐） */
export interface PlanEditableFields {
  name: string;
  priceMonth: number;
  priceYear: number;
  maxConnections: number;
  syncQuotaBytes: number;
  syncVersionRetention: number;
  features: number;
}

export interface IPlanRepo {
  findByCode(code: PlanCode): Promise<Plan | undefined>;
  listAll(): Promise<Plan[]>;
  /** 播种套餐数据（仅 schema 初始化时调用） */
  seed(plans: Array<Omit<Plan, 'createTime' | 'updateTime'>>): Promise<void>;
  /** 更新套餐可编辑字段（管理后台编辑） */
  update(code: PlanCode, fields: PlanEditableFields): Promise<void>;
}

export interface ISubscriptionRepo {
  findByUserId(userId: number): Promise<Subscription | undefined>;
  /**
   * 批量取订阅（管理端列表用）。
   *
   * 存在的理由是消掉 N+1：`listUsers` 原本在循环里逐个 `findByUserId`，
   * 而 admin-ui 固定请求 limit=500，一次列表就是 500 次串行往返、独占一条池连接。
   * 传空数组时不应发起查询。
   */
  findByUserIds(userIds: number[]): Promise<Subscription[]>;
  upsert(sub: Omit<Subscription, 'id' | 'createTime' | 'updateTime'> & { id?: number }): Promise<Subscription>;
  listAll(): Promise<Subscription[]>;
  listByStatus(status: SubStatus): Promise<Subscription[]>;
  /** 到期降级：status=active 且 period_end_time < now → status=expired, user.plan_code=free */
  downgradeExpired(now: Date): Promise<number>;
}

export interface IRefreshTokenRepo {
  create(token: Omit<RefreshToken, 'id' | 'createTime' | 'updateTime'>): Promise<RefreshToken>;
  findByHash(hash: string): Promise<RefreshToken | undefined>;
  findById(id: number): Promise<RefreshToken | undefined>;
  revoke(id: number): Promise<void>;
  /**
   * 原子消费（条件撤销）：仅当该行尚未撤销时置 revoked_time，返回是否由本次调用完成。
   *
   * refresh 轮换必须以此为判据而非「先查后写」—— 后者在并发下会让同一个
   * refresh token 签出两条活跃会话，一次性保证失效且重用检测失灵。
   */
  consume(id: number, now: Date): Promise<boolean>;
  /** 撤销某用户全部会话（token 重用时强制下线所有设备） */
  revokeAllForUser(userId: number): Promise<void>;
  /** 撤销某用户在某设备上的全部活跃会话（同设备重登顶掉旧会话） */
  revokeByDevice(userId: number, deviceId: string): Promise<void>;
  countActiveForUser(userId: number, now: Date): Promise<number>;
  listActiveForUser(userId: number, now: Date): Promise<SessionInfo[]>;
  updateLastUsed(id: number, time: Date): Promise<void>;
}

/** 设备实体仓储（设备固有信息，独立于会话） */
export interface IDeviceRepo {
  upsert(device: Omit<Device, 'id' | 'createTime' | 'updateTime'>): Promise<Device>;
  listByUser(userId: number): Promise<Device[]>;
  /** 设备事件留痕（升级/系统变化/首次登记） */
  listEvents(userId: number, deviceId: string): Promise<DeviceEvent[]>;
}

/** 连接元数据仓储（明文，计量/分析；内容仍加密） */
export type ConnectionMetaInput = Omit<ConnectionMeta, 'id' | 'userId' | 'createTime' | 'updateTime'>;
export interface IConnectionMetaRepo {
  /** 全量替换某用户连接元数据（含删除墓碑），返回落库后的活跃连接数 */
  replaceAll(userId: number, metas: ConnectionMetaInput[]): Promise<number>;
  countActive(userId: number): Promise<number>;
  listByUser(userId: number): Promise<ConnectionMeta[]>;
}

/** 同步事件留痕仓储 */
export interface ISyncEventRepo {
  record(event: Omit<SyncEvent, 'id' | 'createTime'>): Promise<void>;
  listByUser(userId: number, limit?: number): Promise<SyncEvent[]>;
}

/** 用量行为仓储（连接打开/查询执行的累计计数） */
export interface IUsageEventRepo {
  record(userId: number, deviceId: string | undefined, kind: UsageEvent['kind'], count: number): Promise<void>;
  listByUser(userId: number, limit?: number): Promise<UsageEvent[]>;
}

/**
 * 同步数据访问（方案 A：分节存储 + 历史版本回滚）。
 * - getSection / putSection：当前版本读写
 * - pushSection：乐观锁写入 + 历史快照（单事务），push 的唯一入口
 * - recordVersion / listVersions / getVersion / pruneVersions：历史版本
 * - rollback：取旧版本密文写回当前行（乐观锁，version+1）
 */
export interface ISyncRepo {
  getSection(userId: number, section: SectionType): Promise<SyncSection | undefined>;
  listSections(userId: number): Promise<SyncSection[]>;
  /** 写当前版本（不存在则插入），无版本校验；仅管理/播种路径使用。返回新 version */
  putSection(userId: number, section: SectionType, encryptedData: string, version: number): Promise<number>;
  /**
   * 乐观锁写入当前版本 + 记录历史快照，两者同一事务。
   * 返回新版本号，或 null 表示版本冲突（未产生任何写入）。
   * dataBytes = 0 时只写当前版本，不记快照。
   */
  pushSection(userId: number, section: SectionType, encryptedData: string, baseVersion: number, dataBytes: number): Promise<number | null>;
  /** 记录历史版本快照（同一 (user, section, version) 覆盖写） */
  recordVersion(userId: number, section: SectionType, version: number, encryptedData: string, dataBytes: number): Promise<void>;
  listVersions(userId: number, section: SectionType, limit: number): Promise<SyncVersionSummary[]>;
  getVersion(userId: number, section: SectionType, version: number): Promise<SyncSectionVersion | undefined>;
  /** 清理超保留数的旧版本（按 version 升序删最旧） */
  pruneVersions(userId: number, section: SectionType, retention: number): Promise<void>;
  /** 回滚：取指定版本密文写回当前行，新 version = current+1（乐观锁，冲突重试后抛 ConflictError） */
  rollback(userId: number, section: SectionType, toVersion: number): Promise<number>;
  /** 统计各 section 当前密文字节总和（配额校验用） */
  sumBytes(userId: number): Promise<number>;
}

/** 一条小时粒度流量聚合（route × status_class） */
export interface TrafficStatRow {
  bucketTime: Date;
  route: string;
  statusClass: number;
  count: number;
}

/** 一次被限流拦截的记录 */
export interface TrafficBlockedRow {
  ip: string;
  route: string;
  bucket: string;
  createTime: Date;
}

/**
 * 流量统计仓储。
 *
 * 写入是**批量 upsert**：采集器在内存里攒一分钟，一条 SQL 落库。
 * 逐请求写库会让每个请求多一次 I/O，那是本末倒置。
 */
export interface ITrafficRepo {
  /** 批量累加（同键 count 相加）。空数组是合法输入，直接返回 */
  upsertStats(rows: Array<Omit<TrafficStatRow, 'count'> & { count: number }>): Promise<void>;
  /** 查询时间区间内的聚合行（含起止） */
  queryStats(from: Date, to: Date): Promise<TrafficStatRow[]>;
  /** 批量插入 429 记录 */
  insertBlocked(rows: Array<Omit<TrafficBlockedRow, 'createTime'>>): Promise<void>;
  /** 查询区间内的 429 记录 */
  queryBlocked(from: Date, to: Date, limit: number): Promise<TrafficBlockedRow[]>;
}

/** 限流规则覆盖行（DB 里只存与默认值不同的桶） */
export interface RateLimitRuleRow {
  bucket: string;
  maxRequests: number;
  windowSeconds: number;
  enabled: boolean;
}

/** 免限流 IP */
export interface AllowlistRow {
  ip: string;
  note?: string;
  createTime: Date;
}

/** 限流配置仓储：阈值覆盖 + IP 白名单 */
export interface IRateLimitRepo {
  listRules(): Promise<RateLimitRuleRow[]>;
  upsertRule(rule: RateLimitRuleRow): Promise<void>;
  listAllowlist(): Promise<AllowlistRow[]>;
  addAllowlist(ip: string, note?: string): Promise<void>;
  removeAllowlist(ip: string): Promise<void>;
}
