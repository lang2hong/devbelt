/**
 * 请求 JSON Schema。请求体一律 `additionalProperties: false`，未知字段直接拒绝。
 *
 * 密码的精确 code point 校验（12..128）在 AuthService（Array.from 长度），
 * schema 只兜类型与粗略长度 —— JSON Schema 的 minLength/maxLength 按 UTF-16
 * 单元计数，无法精确表达 Unicode code points。
 */

/** 设备请求字段（实施规格 §5.2 DeviceFields）。 */
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
    displayName: { type: 'string', minLength: 1, maxLength: 200 },
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

/** PATCH /api/console/me 显示名（长度上限由 service 按 code point 校验）。 */
export const updateDisplayNameBody = {
  type: 'object',
  required: ['displayName'],
  additionalProperties: false,
  properties: {
    displayName: { type: 'string', maxLength: 200 },
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

/** 一次性邮件链接认领（body：type + token）。token 固定 base64url 43 字符。 */
export const linkFlowClaimBody = {
  type: 'object',
  required: ['type', 'token'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['verify-email', 'accept-invitation', 'sync-reset'] },
    token: { type: 'string', minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' },
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

// ── 组织域 ──

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

// ── 组织邀请 ──

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

// ── 目录与资源 ──

const nullableId = { anyOf: [{ type: 'string', pattern: '^[0-9]{1,20}$' }, { type: 'null' }] } as const;

export const createFolderBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    parentId: nullableId,
  },
} as const;

export const updateFolderBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    parentId: nullableId,
  },
} as const;

export const createResourceBody = {
  type: 'object',
  required: ['resourceType', 'name', 'content'],
  additionalProperties: false,
  properties: {
    resourceType: { type: 'string', enum: ['connection_template', 'query'] },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    folderId: nullableId,
    content: { type: 'object' },
  },
} as const;

export const updateResourceBody = {
  type: 'object',
  required: ['baseVersion'],
  additionalProperties: false,
  minProperties: 2,
  properties: {
    baseVersion: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    folderId: nullableId,
    content: { type: 'object' },
  },
} as const;

export const folderIdParam = {
  type: 'object',
  required: ['organizationId', 'folderId'],
  properties: {
    organizationId: { type: 'string', pattern: '^[0-9]{1,20}$' },
    folderId: { type: 'string', pattern: '^[0-9]{1,20}$' },
  },
} as const;

export const resourceIdParam = {
  type: 'object',
  required: ['organizationId', 'resourceId'],
  properties: {
    organizationId: { type: 'string', pattern: '^[0-9]{1,20}$' },
    resourceId: { type: 'string', pattern: '^[0-9]{1,20}$' },
  },
} as const;

// ── 个人 E2E 同步（§7 专项）──

/** base64url 无 padding，固定字符长度。 */
const b64url = (min: number, max: number) => ({ type: 'string' as const, minLength: min, maxLength: max, pattern: '^[A-Za-z0-9_-]+$' });
/** u64 十进制字符串（禁前导零；值域上限由服务层 parseU64 再校验）。 */
const u64Str = { type: 'string' as const, pattern: '^(0|[1-9][0-9]{0,19})$' };
/** 协议常量。schema 只做结构校验，值域由服务层判 SYNC_PROTOCOL_UNSUPPORTED（§8）。 */
const protocolV1 = { type: 'integer' as const };
const suiteV1 = { type: 'string' as const };

const syncEnvelope = {
  type: 'object',
  required: ['protocolVersion', 'cipherSuite', 'formatVersion', 'envelopeVersion', 'nonce', 'ciphertext', 'tag'],
  additionalProperties: false,
  properties: {
    protocolVersion: protocolV1,
    cipherSuite: suiteV1,
    formatVersion: protocolV1,
    envelopeVersion: u64Str,
    nonce: b64url(16, 16),
    ciphertext: b64url(43, 43),
    tag: b64url(22, 22),
  },
} as const;

const smpKdfSchema = {
  type: 'object',
  required: ['alg', 'version', 'memoryKiB', 'iterations', 'parallelism', 'salt', 'outputBytes'],
  additionalProperties: false,
  properties: {
    alg: { type: 'string', enum: ['argon2id'] },
    version: { type: 'integer', enum: [1] },
    memoryKiB: { type: 'integer', minimum: 65536, maximum: 262144 },
    iterations: { type: 'integer', minimum: 3, maximum: 10 },
    parallelism: { type: 'integer', minimum: 1, maximum: 4 },
    salt: b64url(22, 22),
    outputBytes: { type: 'integer', enum: [32] },
  },
} as const;

const recoveryKdfSchema = {
  type: 'object',
  required: ['alg', 'version', 'salt', 'outputBytes'],
  additionalProperties: false,
  properties: {
    alg: { type: 'string', enum: ['hkdf-sha256'] },
    version: { type: 'integer', enum: [1] },
    salt: b64url(22, 22),
    outputBytes: { type: 'integer', enum: [32] },
  },
} as const;

const syncNewState = {
  type: 'object',
  required: ['protocolVersion', 'cipherSuite', 'formatVersion', 'smpKdf', 'recoveryKdf', 'envelopeSmp', 'envelopeRecovery', 'signPub', 'recoverSignPub'],
  additionalProperties: false,
  properties: {
    protocolVersion: protocolV1,
    cipherSuite: suiteV1,
    formatVersion: protocolV1,
    smpKdf: smpKdfSchema,
    recoveryKdf: recoveryKdfSchema,
    envelopeSmp: syncEnvelope,
    envelopeRecovery: syncEnvelope,
    signPub: b64url(43, 43),
    recoverSignPub: b64url(43, 43),
  },
} as const;

/** SignedMutation 公共字段（keyEpoch/mutationId/signature + 协议版本）。 */
const signedMutationProps = {
  protocolVersion: protocolV1,
  keyEpoch: u64Str,
  mutationId: b64url(22, 22),
  signature: b64url(86, 86),
} as const;

export const syncInitBody = {
  type: 'object',
  required: ['newState'],
  additionalProperties: false,
  properties: { newState: syncNewState },
} as const;

export const syncChangeKeyBody = {
  type: 'object',
  required: ['protocolVersion', 'keyEpoch', 'mutationId', 'signature', 'expectedStateVersion', 'smpKdf', 'envelopeSmp'],
  additionalProperties: false,
  properties: {
    ...signedMutationProps,
    expectedStateVersion: u64Str,
    smpKdf: smpKdfSchema,
    envelopeSmp: syncEnvelope,
  },
} as const;

export const syncRecoverBody = {
  type: 'object',
  required: ['protocolVersion', 'keyEpoch', 'mutationId', 'signature', 'expectedStateVersion', 'smpKdf', 'envelopeSmp', 'recoveryKdf', 'envelopeRecovery', 'recoverSignPub'],
  additionalProperties: false,
  properties: {
    ...signedMutationProps,
    expectedStateVersion: u64Str,
    smpKdf: smpKdfSchema,
    envelopeSmp: syncEnvelope,
    recoveryKdf: recoveryKdfSchema,
    envelopeRecovery: syncEnvelope,
    recoverSignPub: b64url(43, 43),
  },
} as const;

export const syncDestroyBody = {
  type: 'object',
  required: ['protocolVersion', 'keyEpoch', 'mutationId', 'signature', 'expectedStateVersion', 'newState'],
  additionalProperties: false,
  properties: {
    ...signedMutationProps,
    expectedStateVersion: u64Str,
    newState: syncNewState,
  },
} as const;

/** 三个不可逆确认必须为字面量 true（§7.5.1）。 */
const confirmTrue = { type: 'boolean' as const, enum: [true] as const };

export const syncResetAfterLossBody = {
  type: 'object',
  required: ['protocolVersion', 'resetToken', 'confirmIrreversible', 'confirmDataLoss', 'confirmNoRecovery', 'newState'],
  additionalProperties: false,
  properties: {
    protocolVersion: protocolV1,
    resetToken: b64url(43, 43),
    confirmIrreversible: confirmTrue,
    confirmDataLoss: confirmTrue,
    confirmNoRecovery: confirmTrue,
    newState: syncNewState,
  },
} as const;

const recordIdSchema = { type: 'string' as const, minLength: 1, maxLength: 171, pattern: '^[A-Za-z0-9_-]+$' };

export const syncPutRecordBody = {
  type: 'object',
  required: ['protocolVersion', 'keyEpoch', 'mutationId', 'signature', 'recordId', 'baseVersion', 'cipherSuite', 'formatVersion', 'nonce', 'ciphertext', 'tag'],
  additionalProperties: false,
  properties: {
    ...signedMutationProps,
    recordId: recordIdSchema,
    baseVersion: u64Str,
    cipherSuite: suiteV1,
    formatVersion: protocolV1,
    nonce: b64url(16, 16),
    ciphertext: b64url(1, 349526),
    tag: b64url(22, 22),
  },
} as const;

export const syncDeleteRecordBody = {
  type: 'object',
  required: ['protocolVersion', 'keyEpoch', 'mutationId', 'signature', 'recordId', 'baseVersion'],
  additionalProperties: false,
  properties: {
    ...signedMutationProps,
    recordId: recordIdSchema,
    baseVersion: u64Str,
  },
} as const;

export const syncRecordIdParam = {
  type: 'object',
  required: ['recordId'],
  properties: { recordId: recordIdSchema },
} as const;

export const syncRecordsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    after: u64Str,
    snapshotSequence: u64Str,
    limit: { type: 'integer', minimum: 1, maximum: 256 },
  },
} as const;
