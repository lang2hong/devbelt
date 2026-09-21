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

export interface AdminOrganization {
  organizationId: string;
  name: string;
  status: string;
  planCode: string | null;
  seatLimit: number | null;
  activeMemberCount: number;
  invitedCount: number;
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
  organizationId: string | null;
  sourceIp: string | null;
  requestId: string | null;
  result: string;
  failureCode: string | null;
  reason: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
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

async function toPage<T>(res: Response): Promise<{ items: T[]; nextCursor: string | null }> {
  const body = (await res.json()) as Page<T>;
  return { items: body.items, nextCursor: body.nextCursor };
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

// ── 组织 ──

export interface OrgFilters {
  namePrefix?: string;
  status?: 'active' | 'closed';
  planCode?: string;
  cursor?: string;
}

export async function listOrganizations(
  filters: OrgFilters = {},
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Page<AdminOrganization>>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/admin/organizations${qs(filters)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await toPage<AdminOrganization>(res) };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function adjustOrganizationSubscription(
  organizationId: string,
  input: { planCode: string; seatLimit: number; periodEndTime: string | null; reason: string; expectedVersion: number },
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<{ subscriptionVersion: number }>> {
  if (!token) return { kind: 'unauthorized' };
  const body: Record<string, unknown> = { planCode: input.planCode, seatLimit: input.seatLimit, reason: input.reason, expectedVersion: input.expectedVersion };
  if (input.periodEndTime) body.periodEndTime = input.periodEndTime;
  try {
    const res = await authedFetch(
      `/api/admin/organizations/${organizationId}/subscription`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify(body) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
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
  organizationId?: string;
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
  filters: { fromTime?: string; toTime?: string; actorUserId?: string; eventType?: string; targetType?: string; organizationId?: string },
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
  if (filters.organizationId) f.organizationId = Number(filters.organizationId);
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
  planCode: string;
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
  planCode?: string;
  createdFrom?: string;
  createdTo?: string;
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
