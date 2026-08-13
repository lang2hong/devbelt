import type { PlanCode, Role, SubStatus, SectionType, UserStatus } from '../domain/enums.js';
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
}

export interface IPlanRepo {
  findByCode(code: PlanCode): Promise<Plan | undefined>;
  listAll(): Promise<Plan[]>;
  /** 播种套餐数据（仅 schema 初始化时调用） */
  seed(plans: Array<Omit<Plan, 'createTime' | 'updateTime'>>): Promise<void>;
}

export interface ISubscriptionRepo {
  findByUserId(userId: number): Promise<Subscription | undefined>;
  upsert(sub: Omit<Subscription, 'id' | 'createTime' | 'updateTime'> & { id?: number }): Promise<Subscription>;
  listByStatus(status: SubStatus): Promise<Subscription[]>;
  /** 到期降级：status=active 且 period_end_time < now → status=expired, user.plan_code=free */
  downgradeExpired(now: Date): Promise<number>;
}

export interface IRefreshTokenRepo {
  findByHash(hash: string): Promise<RefreshToken | undefined>;
  create(token: Omit<RefreshToken, 'id' | 'createTime'>): Promise<RefreshToken>;
  revoke(id: number): Promise<void>;
  /** 撤销某用户全部会话（token 重用时强制下线所有设备） */
  revokeAllForUser(userId: number): Promise<void>;
  countActiveForUser(userId: number, now: Date): Promise<number>;
  listActiveForUser(userId: number, now: Date): Promise<SessionInfo[]>;
  updateLastUsed(id: number, time: Date): Promise<void>;
}

export interface IPatRepo {
  create(pat: Omit<Pat, 'id' | 'createTime'>): Promise<Pat>;
  findByHash(hash: string): Promise<Pat | undefined>;
  findById(id: number): Promise<Pat | undefined>;
  listByUser(userId: number): Promise<Pat[]>;
  revoke(id: number): Promise<void>;
  countActiveForUser(userId: number): Promise<number>;
  updateLastUsed(id: number, time: Date): Promise<void>;
}

/**
 * 同步数据访问（方案 A：分节存储 + 历史版本回滚）。
 * - getSection / putSection：当前版本读写
 * - recordVersion / listVersions / getVersion / pruneVersions：历史版本
 * - rollback：取旧版本密文写回当前行（version+1）
 */
export interface ISyncRepo {
  getSection(userId: number, section: SectionType): Promise<SyncSection | undefined>;
  listSections(userId: number): Promise<SyncSection[]>;
  /** 写当前版本（不存在则插入）；返回新 version */
  putSection(userId: number, section: SectionType, encryptedData: string, version: number): Promise<number>;
  /** 记录历史版本快照 */
  recordVersion(userId: number, section: SectionType, version: number, encryptedData: string, dataBytes: number): Promise<void>;
  listVersions(userId: number, section: SectionType, limit: number): Promise<SyncVersionSummary[]>;
  getVersion(userId: number, section: SectionType, version: number): Promise<SyncSectionVersion | undefined>;
  /** 清理超保留数的旧版本（按 version 升序删最旧） */
  pruneVersions(userId: number, section: SectionType, retention: number): Promise<void>;
  /** 回滚：取指定版本密文写回当前行，新 version = current+1 */
  rollback(userId: number, section: SectionType, toVersion: number): Promise<number>;
  /** 统计各 section 当前密文字节总和（配额校验用） */
  sumBytes(userId: number): Promise<number>;
}
