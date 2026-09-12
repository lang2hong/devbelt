import { getAccessToken } from './tokenStore';
import { authedFetch, type FetchLike } from './authedFetch';
import { resolveErrorKind } from './httpError';

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
  | { kind: 'failure' };

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

async function failure(res: Response): Promise<{ kind: Failure }> {
  return { kind: await resolveErrorKind(res) as Failure };
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
  status?: 'active' | 'disabled';
  planCode?: string;
  cursor?: string;
}

export async function listUsers(
  filters: UserFilters = {},
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Page<AdminUser>>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/console/admin/users${qs(filters)}`, { headers: auth(token) }, fetchImpl);
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
      `/api/console/admin/users/${userId}/status`,
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
      `/api/console/admin/users/${userId}/subscription`,
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
    const res = await authedFetch(`/api/console/admin/organizations${qs(filters)}`, { headers: auth(token) }, fetchImpl);
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
      `/api/console/admin/organizations/${organizationId}/subscription`,
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
    const res = await authedFetch(`/api/console/admin/audit${qs(filters)}`, { headers: auth(token) }, fetchImpl);
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
      '/api/console/admin/audit/exports',
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
    const res = await authedFetch(`/api/console/admin/orders${qs(filters)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: await toPage<AdminOrder>(res) };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}