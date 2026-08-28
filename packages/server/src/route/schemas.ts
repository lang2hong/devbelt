/**
 * V3 请求 JSON Schema（切片 1：身份与会话）。
 *
 * 与 V2 的关键差异：请求体一律 `additionalProperties: false`（实施规格 §5.1
 * 「请求体必须严格闭合，出现未知字段即拒绝」）。Greenfield 无兼容包袱。
 *
 * 密码的精确 code point 校验（12..128）在 AuthService（Array.from 长度），
 * schema 只兜类型与粗略长度 —— JSON Schema 的 minLength/maxLength 按 UTF-16
 * 单元计数，无法精确表达 Unicode code points。
 */

/** 设备请求字段（实施规格 §4.6 DeviceFields）。 */
export const deviceKeySchema = {
  type: 'string',
  minLength: 16,
  maxLength: 128,
  pattern: '^[A-Za-z0-9_-]+$',
} as const;

export const deviceFields = {
  type: 'object',
  required: ['deviceKey', 'devicePlatform', 'deviceName', 'clientVersion'],
  additionalProperties: false,
  properties: {
    deviceKey: deviceKeySchema,
    devicePlatform: { type: 'string', maxLength: 100 },
    deviceName: { type: 'string', maxLength: 100 },
    clientVersion: { type: 'string', maxLength: 100 },
  },
} as const;

export const registerBody = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 255 },
    password: { type: 'string', maxLength: 256 },
    displayName: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

export const loginBody = {
  type: 'object',
  required: ['email', 'password', 'deviceKey', 'devicePlatform', 'deviceName', 'clientVersion'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 255 },
    password: { type: 'string', maxLength: 256 },
    ...deviceFields.properties,
  },
} as const;

export const refreshBody = {
  type: 'object',
  required: ['refreshToken', 'deviceKey', 'devicePlatform', 'deviceName', 'clientVersion'],
  additionalProperties: false,
  properties: {
    refreshToken: { type: 'string', minLength: 1, maxLength: 512 },
    ...deviceFields.properties,
  },
} as const;

export const changePasswordBody = {
  type: 'object',
  required: ['currentPassword', 'newPassword'],
  additionalProperties: false,
  properties: {
    currentPassword: { type: 'string', maxLength: 256 },
    newPassword: { type: 'string', maxLength: 256 },
  },
} as const;

/** 匿名重发验证 token（body 只含 email）。 */
export const resendBody = {
  type: 'object',
  required: ['email'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 255 },
  },
} as const;

/** 邮箱验证 token（path 参数，base64url）。 */
export const verificationTokenParam = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;

/** 设备 id（path 参数；十进制字符串，BIGINT 精确范围）。 */
export const deviceIdParam = {
  type: 'object',
  required: ['deviceId'],
  properties: { deviceId: { type: 'string', pattern: '^[0-9]{1,20}$' } },
} as const;

// ── 组织域（切片 2）──

export const createOrganizationBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
} as const;

export const updateOrganizationBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
} as const;

export const assignRoleBody = {
  type: 'object',
  required: ['role'],
  additionalProperties: false,
  properties: { role: { type: 'string', enum: ['admin', 'member'] } },
} as const;

export const organizationIdParam = {
  type: 'object',
  required: ['organizationId'],
  properties: { organizationId: { type: 'string', pattern: '^[0-9]{1,20}$' } },
} as const;

export const membershipIdParam = {
  type: 'object',
  required: ['organizationId', 'membershipId'],
  properties: {
    organizationId: { type: 'string', pattern: '^[0-9]{1,20}$' },
    membershipId: { type: 'string', pattern: '^[0-9]{1,20}$' },
  },
} as const;

// ── 组织邀请（切片 3）──

export const createInvitationBody = {
  type: 'object',
  required: ['email'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 255 },
    role: { type: 'string', enum: ['admin', 'member'] },
  },
} as const;

export const invitationIdParam = {
  type: 'object',
  required: ['organizationId', 'invitationId'],
  properties: {
    organizationId: { type: 'string', pattern: '^[0-9]{1,20}$' },
    invitationId: { type: 'string', pattern: '^[0-9]{1,20}$' },
  },
} as const;

export const invitationTokenParam = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', minLength: 1, maxLength: 256 } },
} as const;