import { ensureCsrf, refresh, type FetchLike } from './api/consoleAuth';

export type RefreshOutcome = { kind: 'ok' } | { kind: 'unauthorized' } | { kind: 'failure' };

function defaultCookie(): string {
  return typeof document === 'undefined' ? '' : document.cookie;
}

let inflight: Promise<RefreshOutcome> | null = null;

/**
 * 会话中途 401 的静默恢复（P3 §4.3 + F1）：用 refresh cookie 续一次 access token。
 * 单飞：并发 401 共享同一次刷新；settle 后清空 inflight（F3），下次 401 会再次真正刷新。
 */
export function refreshSession(
  fetchImpl: FetchLike = fetch,
  cookieReader: () => string = defaultCookie,
): Promise<RefreshOutcome> {
  if (!inflight) {
    inflight = (async (): Promise<RefreshOutcome> => {
      const csrf = await ensureCsrf(fetchImpl, cookieReader);
      const r = await refresh(csrf, fetchImpl);
      if (r.kind === 'ok') return { kind: 'ok' };
      if (r.kind === 'invalid-credentials') return { kind: 'unauthorized' };
      return { kind: 'failure' };
    })()
      .catch(() => ({ kind: 'failure' }) as const)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}