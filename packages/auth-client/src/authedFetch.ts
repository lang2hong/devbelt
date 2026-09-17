import { refreshSession } from './session';
import { getAccessToken } from './tokenStore';
import type { RefreshOutcome } from './session';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type RefreshAccessToken = (fetchImpl: FetchLike) => Promise<RefreshOutcome>;

/**
 * 认证请求包装（P3 §4.3 + F1）：请求返回 401 时，先单飞刷新 access token，
 * 成功后以新 token 重放同一请求一次（重放复用原 headers，含 Idempotency-Key，
 * 因此写请求的幂等键不变）。刷新失败或重放仍 401 才把 401 透传给调用方。
 */
export async function authedFetch(
  input: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  refreshImpl: RefreshAccessToken = (f) => refreshSession(f),
): Promise<Response> {
  const first = await fetchImpl(input, init);
  if (first.status !== 401) return first;

  const refreshed = await refreshImpl(fetchImpl);
  if (refreshed.kind !== 'ok') return first;

  const token = getAccessToken();
  if (!token) return first;

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetchImpl(input, { ...init, headers });
}