import type { FastifyRequest } from 'fastify';

/**
 * 控制台 Cookie 工具（P3 §4.2/§8）。
 *
 * 安全默认：非开发环境一律使用 `__Host-` 前缀 + `Secure`。仅在「NODE_ENV ===
 * 'development' 且控制台 host 为 loopback」双条件同时成立时，才允许 `dev_` 前缀 +
 * `Secure=false` 的例外（§8 L330：该例外禁止出现在测试/预发/生产）。
 */

export function secureCookiesEnabled(): boolean {
  return !(process.env.NODE_ENV === 'development' && isLoopbackConsoleHost());
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackConsoleHost(): boolean {
  const base = (process.env.DEVBELT_DB_SMTP_BASE_URL || 'http://localhost:5173').trim();
  try {
    return LOOPBACK_HOSTS.has(new URL(base).hostname);
  } catch {
    return false;
  }
}

export const linkFlowCookieName = (): string =>
  secureCookiesEnabled() ? '__Host-devbelt_link_flow' : 'dev_devbelt_link_flow';

export const csrfCookieName = (): string =>
  secureCookiesEnabled() ? '__Host-devbelt_csrf' : 'dev_devbelt_csrf';

export const refreshCookieName = (): string =>
  secureCookiesEnabled() ? '__Host-devbelt_refresh' : 'dev_devbelt_refresh';

/** 从请求 Cookie 头读取指定 cookie 的值。畸形百分号编码/控制字符一律视为未提供。 */
export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const prefix = `${name}=`;
  for (const part of header.split(';')) {
    const p = part.trim();
    if (p.startsWith(prefix)) {
      let value: string;
      try {
        value = decodeURIComponent(p.slice(prefix.length));
      } catch {
        // `%` 后接非法十六进制等畸形输入：不能抛错（否则匿名请求即可打 500）。
        return undefined;
      }
      // 控制字符不应出现在合法 cookie 值中，出现即视为无效。
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
      return value;
    }
  }
  return undefined;
}

export interface CookieOptions {
  httpOnly?: boolean;
  maxAgeSeconds?: number;
  /** 置为过期并清除。 */
  clear?: boolean;
}

/** 构造一行 Set-Cookie 字符串（不含 Domain；__Host- 前缀已隐含 Path=/）。 */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (opts.clear) {
    parts.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'SameSite=Lax');
    if (secureCookiesEnabled()) parts.push('Secure');
  } else {
    parts.push(`Max-Age=${opts.maxAgeSeconds ?? 600}`, 'SameSite=Lax');
    if (secureCookiesEnabled()) parts.push('Secure');
    if (opts.httpOnly) parts.push('HttpOnly');
  }
  return parts.join('; ');
}