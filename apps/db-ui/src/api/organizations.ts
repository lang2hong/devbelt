import { getAccessToken } from '@devkit/auth-client';
import { authedFetch, type FetchLike } from '@devkit/auth-client';
import { resolveErrorKind } from '@devkit/auth-client';

/**
 * 组织 API 客户端（P3 §6）。写请求（create/update/close/leave/assignRole/removeMember/
 * invite/revokeInvitation）为 console 写，幂等键由调用方铸定并在可重试失败时复用，
 * 携带会话绑定 CSRF。目录/资源只读元数据（folder.read / resource.read），绝不读取
 * resource 详情（aud:'extension'，浏览器不可达 content / 密文 / E2EE 材料）。
 * 全部走 authedFetch：会话中 401 静默刷新后重放一次。
 */

export interface OrgSummary {
  organizationId: string;
  name: string;
  status: string;
  closedTime: string | null;
  role: string;
}

export interface Member {
  membershipId: string;
  displayName: string | null;
  role: string;
  status: string;
  joinedTime: string | null;
  email?: string | null;
}

export interface Invitation {
  invitationId: string;
  email: string;
  role: string;
  expiresTime: string;
  invitedTime?: string;
}

export interface Folder {
  folderId: string;
  name: string;
  parentId: string | null;
}

export interface ResourceSummary {
  resourceId: string;
  resourceType: string;
  name: string;
  folderId: string | null;
  version: number;
  createdByMembershipId: string;
  updatedByMembershipId: string | null;
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

export async function listOrganizations(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<OrgSummary[]>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/db/organizations', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()).organizations as OrgSummary[] };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function createOrganization(
  name: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<OrgSummary>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/db/organizations',
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ name }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()).organization as OrgSummary };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function getOrganization(
  organizationId: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<OrgSummary>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/db/organizations/${organizationId}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()).organization as OrgSummary };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function updateOrganization(
  organizationId: string,
  name: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<unknown>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/db/organizations/${organizationId}`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ name }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function closeOrganization(
  organizationId: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<unknown>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/db/organizations/${organizationId}/close`,
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function leaveOrganization(
  organizationId: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<unknown>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/db/organizations/${organizationId}/leave`,
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function listMembers(
  organizationId: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Member[]>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/db/console/organizations/${organizationId}/members`,
      { headers: auth(token) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()).members as Member[] };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function assignRole(
  organizationId: string,
  membershipId: string,
  role: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<unknown>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/db/organizations/${organizationId}/members/${membershipId}`,
      { method: 'PATCH', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ role }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function removeMember(
  organizationId: string,
  membershipId: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<unknown>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/db/organizations/${organizationId}/members/${membershipId}`,
      { method: 'DELETE', headers: write(csrfToken, token, idempotencyKey) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function listInvitations(
  organizationId: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Invitation[]>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/db/organizations/${organizationId}/invitations`,
      { headers: auth(token) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()).invitations as Invitation[] };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function inviteMember(
  organizationId: string,
  email: string,
  role: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Invitation>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/db/organizations/${organizationId}/invitations`,
      { method: 'POST', headers: write(csrfToken, token, idempotencyKey), body: JSON.stringify({ email, role }) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()).invitation as Invitation };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function revokeInvitation(
  organizationId: string,
  invitationId: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<unknown>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/db/organizations/${organizationId}/invitations/${invitationId}`,
      { method: 'DELETE', headers: write(csrfToken, token, idempotencyKey) },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: await res.json() };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function listFolders(
  organizationId: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Folder[]>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/db/organizations/${organizationId}/folders`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()).folders as Folder[] };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export async function listResources(
  organizationId: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<ResourceSummary[]>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/db/organizations/${organizationId}/resources`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()).resources as ResourceSummary[] };
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}