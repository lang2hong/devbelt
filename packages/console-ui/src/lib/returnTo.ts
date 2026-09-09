/**
 * returnTo 白名单（P3 §4.3）：会话失效跳登录时携带的回跳路径。
 * 仅允许本站 `/console/` 前缀的纯路径名；拒绝绝对/外部/协议相对 URL 与带 token 参数者，
 * 非法一律回退 `/console/account`，防开放重定向。
 */

const ALLOWED_PREFIX = '/console/';
const FALLBACK = '/console/account';

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
  if (!path.startsWith(ALLOWED_PREFIX) || path.includes('//')) return FALLBACK;
  return path;
}