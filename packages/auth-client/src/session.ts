import { ensureCsrf, refresh, type FetchLike } from './consoleAuth';

export type RefreshOutcome = { kind: 'ok' } | { kind: 'unauthorized' } | { kind: 'failure' };

const REFRESH_LOCK = 'devbelt.console-refresh';

function defaultCookie(): string {
  return typeof document === 'undefined' ? '' : document.cookie;
}

/**
 * 跨标签页串行化 refresh：Web Locks 对同一 origin 的标签页共享同一把锁。
 *
 * `inflight` 只覆盖单页 JS 上下文的并发；两个标签页同时遇到 401 会各自用同一
 * refresh cookie 刷新，服务端首个请求轮换 token 后，第二个请求被识别为复用而撤销
 * 整个 family（所有标签页被登出）。Web Locks 让后到的标签页等前者完成后才刷新，
 * 彼时 cookie 已轮换，不再触发复用吊销。
 */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as unknown as { navigator?: { locks?: { request: (name: string, cb: () => Promise<T>) => Promise<T> } } }).navigator?.locks;
  if (locks && typeof locks.request === 'function') {
    return locks.request(REFRESH_LOCK, () => fn());
  }
  return fn();
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
    inflight = withRefreshLock(async (): Promise<RefreshOutcome> => {
      const csrf = await ensureCsrf(fetchImpl, cookieReader);
      const r = await refresh(csrf, fetchImpl);
      if (r.kind === 'ok') return { kind: 'ok' };
      if (r.kind === 'invalid-credentials') return { kind: 'unauthorized' };
      return { kind: 'failure' };
    })
      .catch(() => ({ kind: 'failure' }) as const)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}