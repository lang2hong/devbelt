import { SECTION_TYPES } from '../domain/enums.js';
import { RATE_LIMIT_BUCKETS } from '../ratelimit/rules.js';

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
 * 三个数字必须对齐，此前一个都没对上：
 *  - `sync_sections.encrypted_data` 是 MEDIUMTEXT，硬上限 16 MiB
 *  - Fastify 的 `bodyLimit` 默认 1 MiB，且 app.ts 从未覆盖
 *  - `plans.sync_quota_bytes` 给 Pro 卖 100MB、Team 卖 1GB
 *
 * 结果是单节密文实际永远传不过 1MB，Pro/Team 的同步配额在技术上不可达；
 * 而超限时 Fastify 抛 `FST_ERR_CTP_BODY_TOO_LARGE`（413），message 被
 * errorHandler 替换成 'Bad request'，客户端只看到「push failed: HTTP 413」，
 * 完全不指向真正原因。
 *
 * 现在以 MEDIUMTEXT 的 16 MiB 为准：`app.ts` 的 bodyLimit 按此值加余量，
 * 这里的 maxLength 同步跟上，超限在入口以 400 拒绝而不是打到 MySQL 变 500。
 * 要真正支持 100MB/1GB 需要改列类型 + 分片上传，那是产品决策，不在此处解决。
 */
export const MAX_SECTION_BYTES = 16 * 1024 * 1024;

export const pushBody = {
  type: 'object',
  required: ['section', 'encryptedData', 'baseVersion'],
  properties: {
    section: sectionEnum,
    encryptedData: { type: 'string', maxLength: MAX_SECTION_BYTES },
    baseVersion: { type: 'integer', minimum: 0 },
    // 以下为可选：旧客户端不发这两个字段
    // itemCount 上界对齐 sync_events.item_count 的 INT UNSIGNED，理由同 usageBody
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

/**
 * 用量上报。上界对齐 `usage_events.count` 的 INT UNSIGNED —— 超过会在
 * strict 模式下由 MySQL 报错，不如在入口挡掉。
 */
export const usageBody = {
  type: 'object',
  properties: {
    connectionOpens: { type: 'integer', minimum: 0, maximum: 4294967295 },
    queryExecutes: { type: 'integer', minimum: 0, maximum: 4294967295 },
  },
} as const;

// ── admin ──

const planCodeEnum = { type: 'string', enum: ['free', 'pro', 'team'] } as const;

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
 * 改用户。admin-ui 一次只发一个字段（role / planCode / status 之一），
 * 所以三者都是 optional；但取值必须在枚举内。
 *
 * 校验缺失的后果（此前）：`planCode` 可写成任意字符串，而 `users.plan_code`
 * 没有 FK 指向 `plans.code` → 孤儿套餐码 → 之后 `/api/me` 因 `plan not found`
 * 抛裸 Error → 500。
 */
export const updateUserBody = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: ['user', 'admin'] },
    planCode: planCodeEnum,
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
    maxConnections: { type: 'integer', minimum: 0 },
    syncQuotaBytes: { type: 'integer', minimum: 0 },
    syncVersionRetention: { type: 'integer', minimum: 0 },
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

export const deviceEventsParams = {
  type: 'object',
  required: ['id', 'deviceId'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    deviceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

export const providerParam = {
  type: 'object',
  required: ['provider'],
  properties: { provider: { type: 'string', minLength: 1, maxLength: 32 } },
} as const;

/** 流量查询窗口。上限 720 小时（30 天），够看月趋势又不至于把整张表捞出来 */
export const trafficQuery = {
  type: 'object',
  properties: {
    hours: { type: 'integer', minimum: 1, maximum: 720 },
  },
} as const;

export const rateLimitBucketParam = {
  type: 'object',
  required: ['bucket'],
  properties: {
    bucket: { type: 'string', enum: [...RATE_LIMIT_BUCKETS] },
  },
} as const;

/**
 * 阈值修改。
 *
 * `maxRequests` 下限给 1 而不是 0：0 等于「全部拒绝」，那是把自己锁死，
 * 要停用某个桶应该用 `enabled: false`，语义清楚得多。
 * 窗口上限 1 天 —— 再长的窗口在内存 LRU 里没有意义（进程重启就清了）。
 */
export const updateRateLimitBody = {
  type: 'object',
  properties: {
    maxRequests: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    windowSeconds: { type: 'integer', minimum: 1, maximum: 86_400 },
    enabled: { type: 'boolean' },
  },
} as const;

/** IPv6 最长 45 字符，与 DB 列宽一致 */
export const allowlistBody = {
  type: 'object',
  required: ['ip'],
  properties: {
    ip: { type: 'string', minLength: 3, maxLength: 45 },
    note: { type: 'string', maxLength: 120 },
  },
} as const;

export const allowlistIpParam = {
  type: 'object',
  required: ['ip'],
  properties: { ip: { type: 'string', minLength: 3, maxLength: 45 } },
} as const;
