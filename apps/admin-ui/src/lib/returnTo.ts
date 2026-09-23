/**
 * returnTo 白名单：会话失效跳登录时携带的回跳路径。
 *
 * 约定为 **DB 控制台内的应用相对路径**（如 `/account`、`/orders/42`，不含 `/db` base）。
 * 只接受本站同源的纯路径名；拒绝绝对/协议相对/外部 URL，以及身份页、API、健康检查与
 * 已带 base 的路径，非法一律回退 `/account`，防开放重定向与重复前缀。
 */

const DENIED_PREFIXES = ['/login', '/register', '/verify-email', '/accept-invitation', '/api', '/health', '/db'];
const FALLBACK = '/account';

export function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) return FALLBACK;
  let parsed: URL;
  try {
    parsed = new URL(raw, 'http://localhost');
  } catch {
    return FALLBACK;
  }
  if (parsed.origin !== 'http://localhost') return FALLBACK;
  const path = parsed.pathname;
  if (!path.startsWith('/') || path.includes('//')) return FALLBACK;
  if (DENIED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return FALLBACK;
  return path;
}