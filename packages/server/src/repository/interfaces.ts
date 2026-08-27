import type { PlanCode, Role, SubStatus, SectionType, UserStatus } from '../domain/enums.js';
import type {
  OrgStatus,
  MemberRole,
  MemberStatus,
  ResourceType,
  AccessScope,
  ResourcePermission,
} from '../domain/enums.js';
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
} from '../domain/entities.js';

/**
 * 数据访问层接口（Repository 模式）。
 * 接口与实现分离：domain/service 仅依赖接口，不依赖具体 DB 驱动。
 * 当前唯一实现为 mysql/，后续可加 postgres/sqlite 实现。
 */

export interface IUserRepo {
  findById(id: number): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  create(email: string, passwordHash: string, role: Role, displayName?: string): Promise<User>;
  updateLastLogin(id: number, time: Date): Promise<void>;
  updateRole(id: number, role: Role): Promise<void>;
  updatePassword(id: number, passwordHash: string): Promise<void>;
  updateStatus(id: number, status: UserStatus): Promise<void>;
  listAll(limit: number, offset: number): Promise<User[]>;
  /**
   * 列出**未软删**的活跃用户（delete_time IS NULL）。
   *
   * 与 count() 的差异：软删用户不再计入可登录/可管理的数量。
   */
  count(): Promise<number>;
  /** 仍能登录的 admin 数量（role='admin' 且 status='active' 且未软删） */
  countAdmins(): Promise<number>;
}

/** 套餐可编辑字段（管理后台编辑套餐）。per-user/org 额度与席位定价 */
export interface PlanEditableFields {
  name: string;
  priceMonth: number;
  priceYear: number;
  seatPriceMonth?: number;
  seatPriceYear?: number;
  includedSeats: number;
  perSeatMaxDevices: number;
  perUserMaxPrivateConnections: number;
  perUserMaxOpenConnections: number;
  perUserPrivateSyncQuotaBytes: number;
  perUserSyncVersionRetention: number;
  perUserHistoryRetentionCount: number;
  orgMaxSharedConnections: number;
  orgSharedSyncQuotaBytes: number;
  orgMaxMembers: number;
  features: number;
}

export interface IPlanRepo {
  findById(id: number): Promise<Plan | undefined>;
  findByCode(code: PlanCode): Promise<Plan | undefined>;
  listAll(): Promise<Plan[]>;
  /** 播种套餐数据（v2 由 migration 002 播种，此方法供测试与管理路径使用） */
  seed(plans: Array<Omit<Plan, 'createTime' | 'updateTime'>>): Promise<void>;
  /** 更新套餐可编辑字段（管理后台编辑） */
  update(code: PlanCode, fields: PlanEditableFields): Promise<void>;
}

export interface ISubscriptionRepo {
  findByOrganizationId(organizationId: number): Promise<Subscription | undefined>;
  /**
   * 批量取订阅（管理端列表用）。
   * 传空数组时不应发起查询。
   */
  findByOrganizationIds(organizationIds: number[]): Promise<Subscription[]>;
  upsert(sub: Omit<Subscription, 'id' | 'createTime' | 'updateTime'> & { id?: number }): Promise<Subscription>;
  listAll(): Promise<Subscription[]>;
  listByStatus(status: SubStatus): Promise<Subscription[]>;
  /**
   * 到期降级**单个组织**：status 可降级且 period_end_time <= now → status=expired。
   * 返回是否改到了行。v2 无 users.plan_code 可重置，只置订阅状态。
   */
  expireOne(organizationId: number, now: Date): Promise<boolean>;
  /**
   * 到期降级**全部**：status 可降级且 period_end_time <= now → status=expired。
   * 定时任务/启动时调用，返回降级行数。
   */
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
  listActiveForUser(userId: number, now: Date): Promise<SessionInfo[]>;
}

/** 设备实体仓储（设备固有信息，独立于会话） */
export interface IDeviceRepo {
  upsert(device: Omit<Device, 'id' | 'createTime' | 'updateTime'>): Promise<Device>;
  listByUser(userId: number): Promise<Device[]>;
  /** 绑定设备：占用配额位（revoked_time=NULL）；登录/同步时对配额内的设备调用 */
  bind(userId: number, deviceId: string): Promise<void>;
  /** 释放设备：归还配额位（revoked_time=NOW()）；用户撤销或管理员撤销时调用 */
  revoke(userId: number, deviceId: string): Promise<void>;
  /** 设备是否绑定中（revoked_time IS NULL） */
  isBound(userId: number, deviceId: string): Promise<boolean>;
  /** 绑定中设备数（即当前占用的设备配额量） */
  countBound(userId: number): Promise<number>;
}

/** 连接元数据仓储（明文，计量/分析；内容仍加密） */
export interface ConnectionMetaInput extends Omit<ConnectionMeta, 'id' | 'userId' | 'createTime' | 'updateTime' | 'deleteTime'> {
  /** 客户端墓碑标记：true 表示该连接已删除，服务端应跳过 upsert 并墓碑 */
  deleted?: boolean;
}
export interface IConnectionMetaRepo {
  /** 全量替换某用户连接元数据（含删除墓碑），返回落库后的活跃连接数 */
  replaceAll(userId: number, metas: ConnectionMetaInput[]): Promise<number>;
  countActive(userId: number): Promise<number>;
  listByUser(userId: number): Promise<ConnectionMeta[]>;
}


/** 管理操作的操作者上下文。ip 只用于留痕，不参与任何判定 */
export interface AuditActor {
  userId: number;
  ip?: string;
}

/** 一条待写入的留痕（id / createTime 由库生成） */
export type AdminAuditInput = Omit<AdminAuditLog, 'id' | 'createTime'>;

/**
 * 管理操作留痕仓储。
 *
 * 写入失败**必须抛错**，调用方要让业务操作一起失败。吞掉错误的后果是
 * 「审计表一坏，所有管理操作变成无痕操作」，且没有任何迹象 ——
 * 这正是攻击者拿到 admin 之后最希望的状态。
 */
export interface IAdminAuditRepo {
  record(entry: AdminAuditInput): Promise<void>;
  list(limit: number, offset: number): Promise<AdminAuditLog[]>;
  count(): Promise<number>;
}

/**
 * webhook 事件去重仓储。
 *
 * 幂等键是 `(provider, event_key)`：eventId 的唯一性只在同一支付商内成立，
 * 两家支付商各自用 `evt_1` 编号完全可能，跨商去重会把第二家的第一个事件吃掉。
 */
export interface IWebhookEventRepo {
  /**
   * 原子地标记"已处理"（INSERT，唯一键兜底）。
   * 返回 true = 首次插入（当前调用者获得处理权）；false = 已有人记过。
   *
   * A5 修复：先 record（原子 INSERT）再 process，消除 seen→process→record
   * 的 check-then-act 竞态（并发双处理导致席位双加）。
   * 若 process 失败，调 forget 撤销记录，允许支付商重试。
   */
  record(provider: string, eventKey: string, detail?: Record<string, unknown>): Promise<boolean>;
  /** 撤销"已处理"标记（process 失败时调用，允许重试） */
  forget(provider: string, eventKey: string): Promise<void>;
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

// ── v2：组织 / 成员 / 席位 / 订单 / 资源 / 审计 ─────────────────────
//
// 以下六组接口服务于以「组织」为计费主体的 v2 模型。S3a 纯增量：
// 不改上方任何 v1 接口，不接入 app.ts / service / route。
// 组织共享资源的权限（organization_resource_permissions）折进
// IOrganizationResourceRepo，作为资源的从属授权操作。

/** 组织创建入参（id / 时间列由库生成） */
export type OrganizationInput = Pick<Organization, 'name' | 'type' | 'ownerUserId'>;

/** 组织可更新字段（管理后台编辑组织） */
export interface OrganizationEditableFields {
  name: string;
  status: OrgStatus;
}

/** 组织仓储（计费主体） */
export interface IOrganizationRepo {
  findById(id: number): Promise<Organization | undefined>;
  /** 某 user 拥有的组织（注册时建 personal org、owner 查询） */
  listByOwner(userId: number): Promise<Organization[]>;
  create(input: OrganizationInput): Promise<Organization>;
  update(id: number, fields: OrganizationEditableFields): Promise<void>;
  /** 软删除（置 delete_time）。owner 删除前需先转移 / 解散组织 */
  softDelete(id: number): Promise<void>;
  listAll(limit: number, offset: number): Promise<Organization[]>;
  count(): Promise<number>;
}

/** 成员创建入参 */
export type MembershipInput = Pick<Membership, 'organizationId' | 'userId' | 'role'>;

/** 成员仓储（成员对席位的占用由此表表达） */
export interface IMembershipRepo {
  findById(id: number): Promise<Membership | undefined>;
  /** 同组织的成员（权限校验、席位校验用） */
  findByOrgAndUser(organizationId: number, userId: number): Promise<Membership | undefined>;
  listByOrganization(organizationId: number): Promise<Membership[]>;
  /** 某 user 在所有组织中的成员关系（求有效席位套餐最高值） */
  listByUser(userId: number): Promise<Membership[]>;
  create(input: MembershipInput): Promise<Membership>;
  updateRole(id: number, role: MemberRole): Promise<void>;
  updateStatus(id: number, status: MemberStatus): Promise<void>;
  /** 软删除成员（置 delete_time；不级联删除资源，留痕仍在） */
  softDelete(id: number): Promise<void>;
  /** 活跃成员数（status=active 且未软删），席位占用计量的依据 */
  countActiveByOrganization(organizationId: number): Promise<number>;
  /** 某 user 的活跃成员关系数（跨组织；用于个人额度判定） */
  countActiveByUser(userId: number): Promise<number>;
}

/** 席位创建入参 */
export type SeatInput = Pick<Seat, 'subscriptionId' | 'organizationId'>;

/** 席位仓储（逐席数量；增减由订单 seat_delta 驱动） */
export interface ISeatRepo {
  findById(id: number): Promise<Seat | undefined>;
  listByOrganization(organizationId: number): Promise<Seat[]>;
  /** 活跃席位数（status=active 且未软删）；活跃成员数须 ≤ 此值 */
  countActiveByOrganization(organizationId: number): Promise<number>;
  create(input: SeatInput): Promise<Seat>;
  /** 撤销席位（status=revoked；订单 seat_delta 为负时调用） */
  revoke(id: number): Promise<void>;
}

/** 订单创建入参（不可变计账；id / 时间列由库生成） */
export type OrderInput = Omit<Order, 'id' | 'createTime' | 'updateTime'>;

/** 订单仓储（不可变计费流水） */
export interface IOrderRepo {
  findById(id: number): Promise<Order | undefined>;
  create(input: OrderInput): Promise<Order>;
  listByOrganization(organizationId: number, limit: number, offset: number): Promise<Order[]>;
  countByOrganization(organizationId: number): Promise<number>;
}

/** 资源创建入参（id / 时间列由库生成） */
export type OrganizationResourceInput = Pick<
  OrganizationResource,
  'organizationId' | 'resourceType' | 'name' | 'accessScope' | 'encryptedData' | 'createdByUserId'
>;

/** 资源可更新字段（管理后台 / 成员编辑共享资源） */
export interface OrganizationResourceEditableFields {
  name?: string;
  accessScope?: AccessScope;
  encryptedData?: string;
  updatedByUserId?: number;
}

/** 组织共享资源仓储（含 restricted 资源的授权） */
export interface IOrganizationResourceRepo {
  findById(id: number): Promise<OrganizationResource | undefined>;
  /** 列出某组织的未软删资源，可按类型过滤 */
  listByOrganization(organizationId: number, type?: ResourceType): Promise<OrganizationResource[]>;
  create(input: OrganizationResourceInput): Promise<OrganizationResource>;
  update(id: number, fields: OrganizationResourceEditableFields): Promise<void>;
  /** 软删除资源（置 delete_time；权限行由外键 CASCADE 跟随） */
  softDelete(id: number): Promise<void>;

  // ── restricted 资源授权 ──
  /** 授予成员对资源的权限（UPSERT：同 resource+membership 覆盖） */
  grantPermission(
    organizationId: number,
    resourceId: number,
    membershipId: number,
    permission: ResourcePermission,
  ): Promise<OrganizationResourcePermission>;
  /** 撤销成员对资源的全部权限 */
  revokePermission(resourceId: number, membershipId: number): Promise<void>;
  /** 列出某资源的全部授权（restricted 资源管理用） */
  listPermissions(resourceId: number): Promise<OrganizationResourcePermission[]>;
  /** 列出某成员的全部授权（求其可访问的 restricted 资源） */
  listPermissionsForMembership(membershipId: number): Promise<OrganizationResourcePermission[]>;
  /** 查单条授权（判定某成员对某资源的具体权限） */
  findPermission(resourceId: number, membershipId: number): Promise<OrganizationResourcePermission | undefined>;
}

/** 组织审计写入入参（id / createTime 由库生成） */
export type OrganizationAuditInput = Omit<OrganizationAuditLog, 'id' | 'createTime'>;

/**
 * 组织协作审计仓储。
 *
 * 写入失败**必须抛错**（与 IAdminAuditRepo 同）：吞掉错误会让审计一坏、
 * 所有组织操作变无痕，正是越权者最希望的状态。
 */
export interface IOrganizationAuditRepo {
  record(entry: OrganizationAuditInput): Promise<void>;
  listByOrganization(organizationId: number, limit: number, offset: number): Promise<OrganizationAuditLog[]>;
  countByOrganization(organizationId: number): Promise<number>;
}

/** 注册账号入参 */
export interface RegistrationAccountInput {
  email: string;
  passwordHash: string;
  role: Role;
  displayName?: string;
}

/** 注册结果：新建的 user / personal org / free 订阅 */
export interface RegistrationResult {
  userId: number;
  organizationId: number;
  subscriptionId: number;
}

/**
 * 注册账号仓储：原子创建 user + personal org + admin membership + free 订阅 + 席位。
 *
 * 必须**原子**：五张表任一失败即整体回滚，不能留下「有 user 无 personal org /
 * 订阅」的半套状态（否则该用户被自己的残留 user 行困住，无法再注册）。
 * 与 bootstrapAdmin 的初始管理员创建同构，但 role / displayName 参数化。
 */
export interface IRegistrationRepo {
  createAccount(input: RegistrationAccountInput): Promise<RegistrationResult>;
}
