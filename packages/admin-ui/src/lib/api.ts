let token: string | null = localStorage.getItem('adminToken') || null;

(function () {
  const m = location.hash.match(/[#&]token=([^&]+)/);
  if (m) {
    token = decodeURIComponent(m[1]);
    localStorage.setItem('adminToken', token);
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      /* ignore */
    }
  }
})();

let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(h: () => void): void {
  unauthorizedHandler = h;
}

export function getToken(): string | null {
  return token;
}

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem('adminToken', t);
  else localStorage.removeItem('adminToken');
}

export class ApiError extends Error {}

export async function api<T = unknown>(
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let body: string | undefined;
  if (opts?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method: opts?.method || 'GET', headers, body });
  if (res.status === 401) {
    setToken(null);
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError('Session expired');
  }
  let data: unknown = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  if (!res.ok) {
    throw new ApiError((data as { message?: string }).message || 'HTTP ' + res.status);
  }
  return data as T;
}