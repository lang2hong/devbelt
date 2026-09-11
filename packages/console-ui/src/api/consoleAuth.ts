import { readCsrfToken } from './csrf';
import { getAccessToken, setAccessToken } from './tokenStore';

export { getAccessToken, setAccessToken };

/**
 * 控制台认证客户端（P3 切片 2）。
 *
 * Refresh token 由服务端 HttpOnly cookie 承载（浏览器自动管理）；本客户端只负责：
 * - access token 仅在内存保存（不落 localStorage/sessionStorage/IndexedDB）；
 * - HTTP 请求前 GET csrf 并回显 X-CSRF-Token；
 * - Web 设备槽位 deviceKey 持久化在 localStorage（非 token/密钥/E2EE 材料）。
 *
 * 会话中的 me/改显示名/改密见 api/me.ts；401 静默刷新见 session.ts。
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type Result<T = undefined> = { kind: 'ok'; value: T } | { kind: 'invalid-credentials' } | { kind: 'rate-limited' } | { kind: 'failure' };

const DEVICE_KEY_STORAGE = 'dbclient.web.deviceKey';

export function getOrCreateDeviceKey(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): string {
  const existing = storage.getItem(DEVICE_KEY_STORAGE);
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  storage.setItem(DEVICE_KEY_STORAGE, key);
  return key;
}

function jsonHeaders(csrfToken: string, token?: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** 拉取匿名/会话 CSRF token（服务端 set cookie，本函数读回值）。 */
export async function ensureCsrf(fetchImpl: FetchLike = fetch, cookieReader: () => string = () => document.cookie): Promise<string> {
  try {
    await fetchImpl('/api/console/auth/csrf', { credentials: 'same-origin' });
  } catch {
    // 网络失败：token 为空，提交会被服务端 CSRF 拒绝，前端按失败处理。
  }
  return readCsrfToken(cookieReader()) ?? '';
}

export interface ConsoleUser {
  userId: string;
  email: string;
  displayName: string | null;
}

export type RegisterResult =
  | { kind: 'ok' }
  | { kind: 'rate-limited' }
  | { kind: 'validation'; message: string }
  | { kind: 'failure' };

export async function register(
  email: string,
  password: string,
  displayName: string,
  csrfToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<RegisterResult> {
  try {
    // displayName 可选：留空时从 body 省略，避免触发 schema `displayName.minLength:1`。
    const body: { email: string; password: string; displayName?: string } = { email, password };
    const name = displayName.trim();
    if (name) body.displayName = name;
    const res = await fetchImpl('/api/console/auth/register', {
      method: 'POST',
      headers: jsonHeaders(csrfToken),
      body: JSON.stringify(body),
    });
    if (res.ok) return { kind: 'ok' };
    if (res.status === 429) return { kind: 'rate-limited' };
    if (res.status === 422) {
      // 透出服务端校验 message（如「password must be 9..128 characters」），不再笼统「注册失败」。
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        return { kind: 'validation', message: body?.error?.message || '输入不符合要求，请检查后重试。' };
      } catch {
        return { kind: 'validation', message: '输入不符合要求，请检查后重试。' };
      }
    }
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

export async function login(
  email: string,
  password: string,
  deviceKey: string,
  csrfToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<Result<ConsoleUser>> {
  try {
    const res = await fetchImpl('/api/console/auth/login', {
      method: 'POST',
      headers: jsonHeaders(csrfToken),
      body: JSON.stringify({ email, password, deviceKey, devicePlatform: 'web', deviceName: 'Web Console', clientVersion: '1.0.0' }),
    });
    if (res.ok) {
      const body = (await res.json()) as { accessToken: string; user: ConsoleUser };
      setAccessToken(body.accessToken);
      return { kind: 'ok', value: body.user };
    }
    if (res.status === 401) return { kind: 'invalid-credentials' };
    if (res.status === 429) return { kind: 'rate-limited' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

export async function refresh(csrfToken: string, fetchImpl: FetchLike = fetch): Promise<Result> {
  try {
    const res = await fetchImpl('/api/console/auth/refresh', {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken },
    });
    if (res.ok) {
      const body = (await res.json()) as { accessToken: string };
      setAccessToken(body.accessToken);
      return { kind: 'ok', value: undefined };
    }
    if (res.status === 401) {
      setAccessToken(null);
      return { kind: 'invalid-credentials' };
    }
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

export async function logout(csrfToken: string, fetchImpl: FetchLike = fetch): Promise<void> {
  try {
    await fetchImpl('/api/console/auth/logout', { method: 'POST', headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken } });
  } catch {
    // 登出本端兜底：即使网络失败也清内存 token。
  } finally {
    setAccessToken(null);
  }
}