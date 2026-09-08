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
  const base = (process.env.SMTP_BASE_URL || 'http://localhost:5173').trim();
  try {
    return LOOPBACK_HOSTS.has(new URL(base).hostname);
  } catch {
    return false;
  }
}

export const linkFlowCookieName = (): string =>
  secureCookiesEnabled() ? '__Host-dbclient_link_flow' : 'dev_dblink_flow';

export const csrfCookieName = (): string =>
  secureCookiesEnabled() ? '__Host-dbclient_csrf' : 'dev_dbcsrf';

/** 从请求 Cookie 头读取指定 cookie 的值。 */
export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const prefix = `${name}=`;
  for (const part of header.split(';')) {
    const p = part.trim();
    if (p.startsWith(prefix)) {
      return decodeURIComponent(p.slice(prefix.length));
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