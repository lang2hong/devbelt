// token 只能来自登录表单。
//
// 这里原本还有一段「从 location.hash 取 #token= 并写入 localStorage」的逻辑，
// 已删除：它让任意一条 /admin#token=xxx 链接都能覆盖当前会话，等于把管理员
// 凭据的注入口开放给任何能让管理员点一下链接的人；同时 token 会留在浏览器
// 历史、会话恢复与可分享链接里（history.replaceState 只能事后清地址栏，
// 清不掉已经写入的历史条目）。
//
// VS Code 扩展侧对应地不再传递 token（见 vscode-ext/src/commands/admin.ts），
// 管理员在此手动登录一次。若要恢复免登录跳转，需服务端签发一次性短时效换取码。
let token: string | null = localStorage.getItem('adminToken') || null;

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