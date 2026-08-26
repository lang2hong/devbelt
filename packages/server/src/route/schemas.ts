import { SECTION_TYPES } from '../domain/enums.js';

/**
 * 共享 JSON Schema 片段。
 *
 * 为什么需要：路由层原先一律 `req.body as any`，且解构写在 try 之外 ——
 * 无 body 的 POST 会让解构抛 TypeError，落到默认错误处理器变成 500 +
 * `"Cannot destructure property ..."`（本该是 400）。`Number(x)` 得到 NaN
 * 后继续进 SQL（`LIMIT NaN` 直接语法错），枚举字段可写入任意字符串。
 *
 * 两条刻意的约定：
 *
 * 1. **一律不设 `additionalProperties: false`**。已发布的客户端可能多送字段
 *    （如 syncClient 的 itemCount/meta 在旧版本里不存在），拒绝未知字段会
 *    打断向后兼容。Fastify 默认会剔除未声明字段而不报错，正是想要的行为。
 *
 * 2. **optional 字段不写进 required**。JSON.stringify 会丢掉值为 undefined
 *    的键，所以 syncClient 传 `itemCount: undefined` 时请求体里根本没这个键。
 */

/** 正整数 ID（路径参数）。Fastify 会把字符串强转成 number。 */
export const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

/** 邮箱 + 密码（register / login）。密码下界与 AuthService 的校验保持一致。 */
export const credentialsBody = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 190 },
    password: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/** refresh token（refresh / logout） */
export const refreshTokenBody = {
  type: 'object',
  required: ['refreshToken'],
  properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } },
} as const;

/**
 * 登出的 body：refreshToken **可选**。
 *
 * `POST /api/auth/refresh` 必须带它（那是唯一的凭据），登出不必：`sid` 是
 * 权威判据，撤销当前会话只需要它（见 AuthService.logout）。
 *
 * 强制必填会让「只存 access token 的客户端」无法真正登出 —— 管理后台正是
 * 如此（refresh token 放进 localStorage 只是把 15 分钟的泄露窗口扩成 90 天）。
 * 那样的话后台的"退出"只是清空前端状态，服务端会话仍有效到自然过期，
 * 共享电脑上等于没登出。
 *
 * 仍然拒绝空字符串：客户端传 `refreshToken: ''` 是明显的 bug（拼错字段、
 * 变量未初始化），静默当作"没传"会把它藏起来。
 */
export const logoutBody = {
  // `['object', 'null']` 而不是 `'object'`：完全不带 body 时 req.body 是
  // undefined，AJV 会以「body must be object」400 掉。要求登出必须带一个
  // JSON body 是无谓的摩擦 —— `curl -X POST .../logout -H 'Authorization: ...'`
  // 是最自然的写法，它应该能工作。
  type: ['object', 'null'],
  properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } },
  additionalProperties: false,
} as const;

export const changePasswordBody = {
  type: 'object',
  required: ['oldPassword', 'newPassword'],
  properties: {
    oldPassword: { type: 'string', minLength: 1, maxLength: 200 },
    newPassword: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/**
 * 同步分节名白名单。
 *
 * SECTION_TYPES 此前定义了却在 src 中零使用 —— 服务端没有任何 section 校验，
 * 非法值会作为参数进 SQL（不构成注入，但会污染 `sync_sections.section`
 * VARCHAR(16)，超长在 strict 模式下报错 → 500）。
 */
const sectionEnum = { type: 'string', enum: [...SECTION_TYPES] } as const;

export const sectionQuery = {
  type: 'object',
  properties: { section: sectionEnum },
} as const;

/** listVersions 必须指定 section（pull 可以不指定，表示全节） */
export const sectionRequiredQuery = {
  type: 'object',
  required: ['section'],
  properties: { section: sectionEnum },
} as const;

/**
 * 单节密文的字节上界。
 *
 * 取值依据是**实测的真实数据规模**，不是列类型能存多少。按含 SSH 配置与环境
 * 标记的完整连接记录测算，单条约 568 字节明文；GCM 密文≈明文，base64 膨胀 4/3，
 * 信封（salt/iv/tag/iterations）约 150 字节：
 *
 *  |   连接数 |   明文 |  请求体 |
 *  |---------|-------|--------|
 *  |      50 |  28KB | 0.04MB |
 *  |     500 | 278KB | 0.36MB |   ← Team 套餐的 maxConnections 上限
 *  |    2000 | 1.1MB | 1.45MB |
 *
 * 也就是说 Team 的 500 连接只要 0.36MB，Fastify 默认的 1 MiB 本来就够用。
 * 真正可能撑大的是 `queries` 节 —— 保存的 SQL 文本没有长度限制。8 MiB 覆盖
 * 约 1 万条连接或大量长 SQL，对当前数据形态留了一个数量级的余量。
 *
 * 之前这里写的是 16 MiB（`sync_sections.encrypted_data` 的 MEDIUMTEXT 硬上限），
 * 那是「列能存多少」而不是「业务需要多少」，选错了依据；而且当时把它设成了
 * **全局** bodyLimit，等于让 `/api/auth/login` 也接受 17MB 请求体。现在全局
 * 收在 1 MiB，只有 `PUT /api/sync` 单独放宽，见 route/sync.ts 的 SYNC_BODY_LIMIT。
 *
 * 与 `plans.sync_quota_bytes` 卖的 Pro 100MB / Team 1GB 依然不匹配 —— 那两个
 * 数字与真实数据规模脱节，该调的是配额而不是这里。真要支持那个量级需要改列
 * 类型 + 分片上传，属产品决策。
 */
export const MAX_SECTION_BYTES = 8 * 1024 * 1024;

export const pushBody = {
  type: 'object',
  required: ['section', 'encryptedData', 'baseVersion'],
  properties: {
    section: sectionEnum,
    encryptedData: { type: 'string', maxLength: MAX_SECTION_BYTES },
    baseVersion: { type: 'integer', minimum: 0 },
    // 以下为可选：itemCount / meta（当前客户端都发）
    // itemCount 上界对齐 sync_sections 的 INT UNSIGNED
    itemCount: { type: 'integer', minimum: 0, maximum: 4294967295 },
    meta: { type: 'array' },
  },
} as const;

export const rollbackBody = {
  type: 'object',
  required: ['section', 'toVersion'],
  properties: {
    section: sectionEnum,
    toVersion: { type: 'integer', minimum: 1 },
  },
} as const;

// ── admin ──

const planCodeEnum = { type: 'string', enum: ['free', 'pro', 'team'] } as const;

/** 流量查询窗口。上限 720 小时（30 天），但内存只保留 60 分钟，超出部分为空 */
export const trafficQuery = {
  type: 'object',
  properties: {
    hours: { type: 'integer', minimum: 1, maximum: 720 },
  },
} as const;

export const planCodeParam = {
  type: 'object',
  required: ['code'],
  properties: { code: planCodeEnum },
} as const;

/**
 * 分页。limit 上界 500 是刻意的：admin-ui 当前就请求 `limit=500` 再客户端分页，
 * 同时避免 `?limit=999999` 把整表拉进内存。
 */
export const paginationQuery = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
  },
} as const;

/**
 * 改用户。admin-ui 一次只发一个字段（role / status 之一），
 * 所以两者都是 optional；但取值必须在枚举内。v2：无 planCode（套餐由组织订阅推导）。
 */
export const updateUserBody = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: ['user', 'admin'] },
    status: { type: 'string', enum: ['active', 'disabled'] },
  },
} as const;

export const renewBody = {
  type: 'object',
  required: ['planCode', 'period'],
  properties: {
    planCode: planCodeEnum,
    period: { type: 'string', enum: ['month', 'year'] },
    provider: { type: 'string', maxLength: 32 },
  },
} as const;

/** 套餐可编辑字段。与 PlanEditableFields 对齐，数值一律非负整数。 */
export const updatePlanBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    priceMonth: { type: 'integer', minimum: 0 },
    priceYear: { type: 'integer', minimum: 0 },
    seatPriceMonth: { type: 'integer', minimum: 0 },
    seatPriceYear: { type: 'integer', minimum: 0 },
    includedSeats: { type: 'integer', minimum: 0 },
    perSeatMaxDevices: { type: 'integer', minimum: 0 },
    perUserMaxPrivateConnections: { type: 'integer', minimum: 0 },
    perUserMaxOpenConnections: { type: 'integer', minimum: 0 },
    perUserPrivateSyncQuotaBytes: { type: 'integer', minimum: 0 },
    perUserSyncVersionRetention: { type: 'integer', minimum: 0 },
    perUserHistoryRetentionCount: { type: 'integer', minimum: 0 },
    orgMaxSharedConnections: { type: 'integer', minimum: 0 },
    orgSharedSyncQuotaBytes: { type: 'integer', minimum: 0 },
    orgMaxMembers: { type: 'integer', minimum: 0 },
    features: { type: 'integer', minimum: 0 },
  },
} as const;

export const sessionIdParams = {
  type: 'object',
  required: ['id', 'sid'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    sid: { type: 'integer', minimum: 1 },
  },
} as const;


export const providerParam = {
  type: 'object',
  required: ['provider'],
  properties: { provider: { type: 'string', minLength: 1, maxLength: 32 } },
} as const;

/** IPv6 最长 45 字符，与 DB 列宽一致 */

