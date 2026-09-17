import { getAccessToken } from '@devkit/auth-client';
import { authedFetch } from '@devkit/auth-client';
import { resolveErrorKind } from '@devkit/auth-client';
import type { ConsoleUser, FetchLike } from '@devkit/auth-client';

/**
 * /api/console/me 相关客户端：取我、改显示名（幂等写）、改密（共享端点）。
 * 改显示名走 authedFetch（401 静默刷新重放，幂等键不变）；改密按契约不带幂等键且
 * 401 = 当前密码错，不触发刷新重放。
 */

export interface ConsoleMeUser extends ConsoleUser {
  emailVerified: boolean;
  status: string;
  lastLoginTime: string | null;
}

export interface ConsoleMe {
  user: ConsoleMeUser;
  platformAdmin: boolean;
  subscription: { planCode: string | null; status: string; periodEndTime: string | null } | null;
  organizations: Array<{ organizationId: string; name: string; role: string }>;
}

export type MeResult = { kind: 'ok'; value: ConsoleMe } | { kind: 'unauthorized' } | { kind: 'failure' };

export async function me(token: string | null = getAccessToken(), fetchImpl: FetchLike = fetch): Promise<MeResult> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/console/me',
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()) as ConsoleMe };
    if (res.status === 401) return { kind: 'unauthorized' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

export type UpdateDisplayNameResult =
  | { kind: 'ok'; displayName: string }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'conflict' }
  | { kind: 'in-progress' }
  | { kind: 'bad-request' }
  | { kind: 'failure' };

function writeHeaders(csrfToken: string, token: string, idempotencyKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey,
  };
}

/** PATCH /api/console/me 显示名（§4.4）。幂等键由调用方铸定并复用。 */
export async function updateDisplayName(
  displayName: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<UpdateDisplayNameResult> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/console/me',
      { method: 'PATCH', headers: writeHeaders(csrfToken, token, idempotencyKey), body: JSON.stringify({ displayName }) },
      fetchImpl,
    );
    if (res.ok) {
      const body = (await res.json()) as { user: { displayName: string } };
      return { kind: 'ok', displayName: body.user.displayName };
    }
    return { kind: await resolveErrorKind(res) };
  } catch {
    return { kind: 'failure' };
  }
}

export type ChangePasswordResult =
  | { kind: 'ok'; reloginRequired: true }
  | { kind: 'invalid-current-password' }
  | { kind: 'failure' };

/** POST /api/auth/change-password（§4.4）。共享 API：不带幂等键；成功即全端下线。 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<ChangePasswordResult> {
  if (!token) return { kind: 'invalid-current-password' };
  try {
    const res = await fetchImpl('/api/auth/change-password', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (res.ok) return { kind: 'ok', reloginRequired: true };
    if (res.status === 401) return { kind: 'invalid-current-password' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}