import { getAccessToken } from '@devbelt/auth-client';
import { authedFetch, type FetchLike } from '@devbelt/auth-client';
import { readServerError } from '@devbelt/auth-client';

/**
 * 平台运营 API 客户端（P3 §6，切片 4）。只向 platform_admin 开放；写请求带
 * 会话绑定 CSRF + Idempotency-Key。导出带 Idempotency-Key（§6）但不落回执。
 */

export interface AdminUser {
  userId: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  status: string;
  role: string;
  lastLoginTime: string | null;
  planCode: string | null;
  deviceCount: number;
  subscriptionVersion: number | null;
  periodEndTime: string | null;
  createTime: string;
}

export interface AdminAuditEvent {
  eventId: string;
  eventTime: string;
  actorUserId: string | null;
  actorRole: string | null;
  eventType: string;
  targetType: string | null;
  targetId: string | null;
  sourceIp: string | null;
  requestId: string | null;
  result: string;
  failureCode: string | null;
  reason: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** 首屏总条数（服务端可选；后续页可能不返回）。 */
  total?: number;
}

export type Result<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'conflict' }
  | { kind: 'in-progress' }
  | { kind: 'bad-request' }
  | { kind: 'failure'; code?: string; message?: string };

type Failure = Exclude<Result<unknown>['kind'], 'ok'>;

function auth(token: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

function write(csrfToken: string, token: string, idempotencyKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey,
  };
}

function qs(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function toPage<T>(res: Response): Promise<Page<T>> {
  const body = (await res.json()) as Page<T>;
  return { items: body.items, nextCursor: body.nextCursor, total: body.total };
}

async function failure(res: Response): Promise<{ kind: Failure; code?: string; message?: string }> {
  const status = res.status;
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 404) return { kind: 'not-found' };
  // 400/422/409 及其余：读一次 body 拿 code/message。
  const err = await readServerError(res);
  const code = err?.code;
  const message = err?.message;
  if (status === 400 || status === 422) return { kind: 'bad-request', code, message };
  if (status === 409) return { kind: code === 'IDEMPOTENCY_IN_PROGRESS' ? 'in-progress' : 'conflict', code, message };
  return { kind: 'failure', code, message };
}

// ── 版本 / 系统状态 ──

export interface ConsoleVersion {
  consoleApiVersion: string;
  serverVersion: string;
  consoleBuildId: string | null;
  buildTime: string | null;
}

export async function getVersion(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<ConsoleVersion>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/console/version', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as ConsoleVersion };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

// ── 用户 ──

export interface UserFilters {
  emailExact?: string;
  userId?: string;
  status?: 'active' | 'disabled';
  planCode?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  cursor?: string;
}

export async function listUsers(
  filters: UserFilters = {},
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Page<AdminUser>>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/users${qs(filters)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await toPage<AdminUser>(res) };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function setUserStatus(
  userId: string,
  status: 'active' | 'disabled',
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ userId: string; status: string }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/users/${userId}/status`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ status, reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()).user };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function adjustUserSubscription(
  userId: string,
  input: { planCode: string; periodEndTime: string | null; reason: string; expectedVersion: number },
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ subscriptionVersion: number }>> {
  if (!token) return { kind: 'unauthorized' };
  const body: Record<string, unknown> = { planCode: input.planCode, reason: input.reason, expectedVersion: input.expectedVersion };
  if (input.periodEndTime) body.periodEndTime = input.periodEndTime;
  try {
    const res = await authedFetch(
      `/api/admin/users/${userId}/subscription`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify(body) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

// ── 同步元数据（P6-S6，只读，无明文）──

export interface AdminSyncKindOverview {
  entityKind: string | null;
  count: number;
  bytes: number;
  lastActivityTime: string | null;
}

/** GET /api/admin/users/:userId/sync-overview：按类型密文元数据（条数/字节/最近更新）。 */
/** 同步记录元数据明细（E2E 加密：仅元数据，绝无密文）。 */
export interface AdminSyncRecord {
  recordId: string;
  entityKind: string | null;
  version: string;
  changeSequence: string;
  bytes: number;
  createTime: string;
  updateTime: string;
}

export interface AdminSyncRecordsPage {
  state: { keyEpoch: string; stateVersion: string; changeSequence: string; protocolVersion: number; cipherSuite: string; formatVersion: number } | null;
  items: AdminSyncRecord[];
  nextCursor: string | null;
}

export async function listSyncRecords(
  userId: string,
  opts: { kind?: string; cursor?: string; limit?: number } = {},
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<AdminSyncRecordsPage>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/users/${userId}/sync-records${qs(opts)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as AdminSyncRecordsPage };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function getSyncOverview(
  userId: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<AdminSyncKindOverview[]>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/users/${userId}/sync-overview`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: ((await res.json()).kinds ?? []) as AdminSyncKindOverview[] };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

// ── 审计 ──

export interface AuditFilters {
  fromTime?: string;
  toTime?: string;
  actorUserId?: string;
  eventType?: string;
  targetType?: string;
  targetId?: string;
  result?: 'success' | 'failed';
  limit?: number;
  cursor?: string;
}

export async function queryAudit(
  filters: AuditFilters = {},
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Page<AdminAuditEvent>>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/audit${qs(filters)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await toPage<AdminAuditEvent>(res) };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function exportAudit(
  format: 'csv' | 'json',
  filters: { fromTime?: string; toTime?: string; actorUserId?: string; eventType?: string; targetType?: string; targetId?: string; result?: 'success' | 'failed' },
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<string>> {
  if (!token) return { kind: 'unauthorized' };
  const f: Record<string, unknown> = {};
  if (filters.fromTime) f.fromTime = filters.fromTime;
  if (filters.toTime) f.toTime = filters.toTime;
  if (filters.actorUserId) f.actorUserId = Number(filters.actorUserId);
  if (filters.eventType) f.eventType = filters.eventType;
  if (filters.targetType) f.targetType = filters.targetType;
  if (filters.targetId) f.targetId = filters.targetId;
  if (filters.result) f.result = filters.result;
  try {
    const res = await authedFetch(
      '/api/admin/audit/exports',
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ format, filters: f }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.text() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

// ── 订单 ──

export interface AdminOrder {
  orderNo: string;
  userId: string;
  userEmail: string | null;
  userDisplayName: string | null;
  purpose: 'plan' | 'topup';
  planCode: string | null;
  skuCode: string | null;
  amountCents: number;
  channel: string;
  status: string;
  channelTradeNo: string | null;
  paidTime: string | null;
  expiresTime: string;
  createTime: string;
  updateTime: string;
}

export interface OrderFilters {
  userId?: string;
  status?: string;
  channel?: string;
  purpose?: string;
  planCode?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  cursor?: string;
}

export async function listAdminOrders(
  filters: OrderFilters = {},
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Page<AdminOrder>>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/orders${qs(filters)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await toPage<AdminOrder>(res) };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 人工退款登记：仅 paid/fulfilled 可退，reason 必填（不接支付渠道退款 API）。 */
export async function refundAdminOrder(
  orderNo: string,
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ orderNo: string; status: string }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/orders/${encodeURIComponent(orderNo)}/refund`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

// ── 发票 ──

export interface AdminInvoice {
  invoiceId: string;
  userId: string;
  title: string;
  taxNo: string | null;
  email: string;
  amountCents: number;
  status: string;
  reason: string | null;
  createTime: string;
}

export interface InvoiceFilters {
  userId?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

export async function listAdminInvoices(
  filters: InvoiceFilters = {},
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Page<AdminInvoice>>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/invoices${qs(filters)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await toPage<AdminInvoice>(res) };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 运营处理发票：requested → issued/rejected/failed；rejected/failed 时 reason 必填。 */
export async function setInvoiceStatus(
  invoiceId: string,
  status: 'issued' | 'rejected' | 'failed',
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ invoiceId: string; status: string }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/invoices/${invoiceId}`,
      {
        method: 'PATCH',
        headers: write(csrfToken, token, idempotencyKey),
        body: JSON.stringify({ status, reason: reason.trim() ? reason.trim() : undefined }),
      },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}
// ── 套餐管理 ──

export interface AdminFeatureDef {
  id: number;
  key: string;
  kind: string;
  label: { en: string; zh: string };
  valueType: string;
  unit: string | null;
  sortOrder: number;
}

export interface AdminPlan {
  id: number;
  code: string;
  kind: string;
  name: string;
  priceCents: number;
  billingUnit: string;
  sortOrder: number;
  status: string;
  version: number;
  features: Record<string, unknown>;
}

/** 列套餐目录（含特性定义，供按类型渲染/校验）。 */
export async function listPlans(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ items: AdminPlan[]; featureDefs: AdminFeatureDef[] }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/admin/plans', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export interface UpdatePlanInput {
  name: string;
  priceCents: number;
  billingUnit: 'month' | 'seat-month';
  sortOrder: number;
  status: 'active' | 'archived';
  features: Array<{ featureKey: string; value: unknown }>;
  expectedVersion: number;
  reason: string;
}

/** 保存套餐（元数据 + 特性整组替换，乐观锁 expectedVersion）。 */
export async function updatePlan(
  planId: number,
  input: UpdatePlanInput,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ plan: AdminPlan }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/plans/${planId}`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify(input) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 新增/更新特性定义。 */
export async function upsertFeatureDef(
  key: string,
  input: { kind: string; label: { en: string; zh: string }; valueType: string; unit: string | null; sortOrder: number; reason: string },
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ featureDef: AdminFeatureDef }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/plan-feature-defs/${encodeURIComponent(key)}`,
      { method: 'PUT', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify(input) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

// ── AI 加油包（P9.1b）──

export interface AdminAiTopupSku {
  code: string;
  label: { en: string; zh: string };
  tokens: number;
  priceCents: number;
  validDays: number;
  status: 'active' | 'disabled';
  sortOrder: number;
}

export interface AdminAiGrant {
  grantId: number;
  orderId: number;
  skuCode: string;
  status: 'active' | 'exhausted' | 'expired' | 'refunded';
  tokensTotal: number;
  tokensUsed: number;
  tokensReserved: number;
  expiresTime: string;
}

export interface AdminAiQuota {
  snapshot: {
    used: number;
    reserved: number;
    monthlyRemaining: number;
    topupRemaining: number;
    remaining: number;
    resetAt: string | null;
  };
  grants: AdminAiGrant[];
  /** 近 6 个月用量（计费 token 口径；月降序）。 */
  months?: Array<{ usageMonth: string; promptTokens: number; completionTokens: number; requestCount: number }>;
  /** 加油包订单实付聚合（用户管理视图）。 */
  topupOrders?: { totalCount: number; paidCount: number; paidCents: number; refundedCount: number; lastPaidTime: string | null };
}

export interface AdminAiTopupOrderResult {
  orderNo: string;
  userId: number;
  skuCode: string;
  tokens: number;
  amountCents: number;
  status: string;
  grantInserted: boolean;
}

/** 全量 SKU（含停用；管理视图）。 */
export async function listAdminAiSkus(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ items: AdminAiTopupSku[] }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/admin/ai/skus', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 更新 SKU（改价/停启用/文案/有效期/排序；reason 必填）。 */
export async function updateAdminAiSku(
  code: string,
  patch: { priceCents?: number; status?: 'active' | 'disabled'; label?: { en: string; zh: string }; validDays?: number; sortOrder?: number },
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ sku: AdminAiTopupSku | null }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/ai/skus/${encodeURIComponent(code)}`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ ...patch, reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 手工建单（金额二次确认：expectedAmountCents 必须等于当前价）。 */
export async function createAdminAiTopupOrder(
  input: { userId: number; skuCode: string; expectedAmountCents: number; reason: string },
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ order: AdminAiTopupOrderResult }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/admin/ai/topup-orders',
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify(input) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 履行（paid → fulfilled；重放幂等；reason 必填）。 */
export async function fulfillAdminAiTopupOrder(
  orderNo: string,
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ order: AdminAiTopupOrderResult }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/ai/topup-orders/${encodeURIComponent(orderNo)}/fulfill`,
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 退款（manual 语义：仅撤销额度，不发起渠道退款；reason 必填）。 */
export async function refundAdminAiTopupOrder(
  orderNo: string,
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ order: AdminAiTopupOrderResult }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/ai/topup-orders/${encodeURIComponent(orderNo)}/refund`,
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 用户配额查询（双段快照 + grants 明细）。 */
export async function getAdminAiQuota(
  userId: number,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<AdminAiQuota>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/ai/users/${userId}/quota`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

// ── AI 模型厂商目录（自带 Key 预设）──

export interface AdminAiProviderModel {
  id: string;
  label?: string;
  default?: boolean;
}

export interface AdminAiProvider {
  code: string;
  name: { en: string; zh: string };
  baseUrl: string;
  models: AdminAiProviderModel[];
  status: 'active' | 'disabled';
  sortOrder: number;
}

/** 全量厂商（含停用；管理视图）。 */
export async function listAdminAiProviders(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ items: AdminAiProvider[] }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/admin/ai/providers', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 新增厂商（code 唯一；reason 必填进审计）。 */
export async function createAdminAiProvider(
  input: { code: string; name: { en: string; zh: string }; baseUrl: string; models: AdminAiProviderModel[]; sortOrder?: number },
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ provider: AdminAiProvider }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/admin/ai/providers',
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ ...input, reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 更新厂商（名称/地址/模型/启停/排序；reason 必填）。 */
export async function updateAdminAiProvider(
  code: string,
  patch: { name?: { en: string; zh: string }; baseUrl?: string; models?: AdminAiProviderModel[]; status?: 'active' | 'disabled'; sortOrder?: number },
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ provider: AdminAiProvider }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/ai/providers/${encodeURIComponent(code)}`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ ...patch, reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

// ── AI 计费引擎（模型计价 / 计费设置 / 财务月报）──

export interface AdminAiModelPricing {
  model: string;
  providerCode: string | null;
  inputCentsPerM: number;
  outputCentsPerM: number;
  weightOverride: number | null;
  /** 每模型计费倍率（012）；null = 用全局。 */
  multiplierOverride: number | null;
  status: 'active' | 'disabled';
}

export interface AdminAiBillingSettings {
  activeModel: string | null;
  upstreamBaseUrl: string | null;
  upstreamApiKeyConfigured: boolean;
  upstreamApiKeyHint: string | null;
  globalMultiplier: number;
  /** 成本测算的典型输出占比（0-1）。 */
  typicalOutputRatio: number;
  env: { model: string; baseUrl: string | null; apiKeyConfigured: boolean };
}

export interface AdminAiFinance {
  usageMonth: string;
  usage: { promptTokens: number; completionTokens: number; requestCount: number };
  billing: { promptTokens: number; completionTokens: number };
  costCents: number | null;
  pricingModel: string | null;
  weight: number;
  multiplier: number;
  revenue: { topupCents: number; planCents: number };
  marginCents: number | null;
}

export async function getAdminAiBillingSettings(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<AdminAiBillingSettings>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/admin/ai/billing-settings', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function updateAdminAiBillingSettings(
  input: { activeModel?: string | null; upstreamBaseUrl?: string | null; upstreamApiKey?: string; clearUpstreamApiKey?: boolean; globalMultiplier?: number; typicalOutputRatio?: number },
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<AdminAiBillingSettings>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/admin/ai/billing-settings',
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ ...input, reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function listAdminAiModelPricing(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ items: AdminAiModelPricing[] }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/admin/ai/model-pricing', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function createAdminAiModelPricing(
  input: { model: string; providerCode?: string | null; inputCentsPerM?: number; outputCentsPerM?: number; weightOverride?: number | null; multiplierOverride?: number | null },
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ pricing: AdminAiModelPricing }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/admin/ai/model-pricing',
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ ...input, reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function updateAdminAiModelPricing(
  model: string,
  patch: { providerCode?: string | null; inputCentsPerM?: number; outputCentsPerM?: number; weightOverride?: number | null; multiplierOverride?: number | null; status?: 'active' | 'disabled' },
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ pricing: AdminAiModelPricing }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/ai/model-pricing/${encodeURIComponent(model)}`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ ...patch, reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 区间毛利统计（012：流水口径，成本取请求当时值）。 */
export interface AdminAiFinanceSummary {
  from: string;
  to: string;
  total: {
    requestCount: number;
    rawPromptTokens: number;
    rawCompletionTokens: number;
    billingPromptTokens: number;
    billingCompletionTokens: number;
    costCents: number | null;
    topupCents: number;
    planCents: number;
    marginCents: number | null;
  };
  months: Array<{
    usageMonth: string;
    requestCount: number;
    rawPromptTokens: number;
    rawCompletionTokens: number;
    billingPromptTokens: number;
    billingCompletionTokens: number;
    costCents: number | null;
    topupCents: number;
    planCents: number;
    marginCents: number | null;
  }>;
  models: Array<{
    model: string;
    requestCount: number;
    rawPromptTokens: number;
    rawCompletionTokens: number;
    billingPromptTokens: number;
    billingCompletionTokens: number;
    costCents: number | null;
  }>;
}

export async function getAdminAiFinanceSummary(
  from: string,
  to: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<AdminAiFinanceSummary>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/ai/finance/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as AdminAiFinanceSummary };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 用户 AI 请求流水（012：计量/积分/当时成本）。 */
export interface AdminAiRequestLog {
  requestId: string | null;
  model: string;
  usageMonth: string;
  status: 'completed' | 'failed' | 'aborted';
  rawPromptTokens: number;
  rawCompletionTokens: number;
  billingPromptTokens: number;
  billingCompletionTokens: number;
  costCents: number | null;
  usageEstimated: boolean;
  latencyMs: number;
  createTime: string;
}

export async function listAdminUserAiRequests(
  userId: string,
  opts: { cursor?: string; limit?: number } = {},
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ items: AdminAiRequestLog[]; nextCursor: string | null }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/ai/users/${userId}/requests${qs(opts)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as { items: AdminAiRequestLog[]; nextCursor: string | null } };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function getAdminAiFinance(
  month: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<AdminAiFinance>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/ai/finance?month=${encodeURIComponent(month)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 用户角色授予/撤销（管理员可在后台管理；不可改自己）。 */
export async function setUserRole(
  userId: string,
  role: 'user' | 'platform_admin',
  reason: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ userId: string; role: string }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/users/${userId}/role`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ role, reason }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()).user };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}


// ── 反馈 / 概览（015） ──

export interface AdminFeedback {
  id: string;
  userId: string | null;
  installId: string | null;
  category: 'bug' | 'feature' | 'other';
  content: string;
  contact: string | null;
  appVersion: string | null;
  os: string | null;
  status: 'new' | 'triaged' | 'done' | 'rejected';
  adminNote: string | null;
  sourceIp: string | null;
  createTime: string;
  updateTime: string;
}

export interface FeedbackFilters {
  status?: string;
  category?: string;
  userId?: string;
  cursor?: string;
  limit?: number;
}

export interface AdminOverview {
  users: { total: number; new7d: number; active7d: number };
  devices: {
    active: number;
    platforms: Array<{ platform: string; count: number }>;
    versions: Array<{ version: string; count: number }>;
  };
  sync: { connectionMetas: number; storageBytes: number };
  ai: { monthTokens: number; monthRequests: number };
  billing: { paidOrders30d: number; revenueCents30d: number };
  feedback: { newCount: number; byStatus: Array<{ status: string; count: number }> };
}

export async function getOverview(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<AdminOverview>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/admin/overview', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as AdminOverview };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function queryFeedback(
  filters: FeedbackFilters = {},
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Page<AdminFeedback>>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/feedback${qs(filters)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await toPage<AdminFeedback>(res) };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function setFeedbackStatus(
  id: string,
  input: { status: 'new' | 'triaged' | 'done' | 'rejected'; adminNote: string | null },
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ id: string; status: string }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/admin/feedback/${id}`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify(input) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()) as { id: string; status: string } };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}
