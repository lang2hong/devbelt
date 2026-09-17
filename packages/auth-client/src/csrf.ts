/**
 * 匿名 CSRF token 读取（P3 §4.2）。
 *
 * 服务端按环境决定 cookie 名前缀：生产 `__Host-devbelt_csrf`，开发 `dev_devbelt_csrf`。
 * 前端无法预知环境，故依次探测两个已知名，从 document.cookie 中取出 token 回显到
 * `X-CSRF-Token` 请求头。token 由服务端随机生成、非 HttpOnly，仅供双提交回显。
 */
export function readCsrfToken(cookieString: string): string | null {
  for (const name of ['__Host-devbelt_csrf', 'dev_devbelt_csrf']) {
    const value = readCookieValue(cookieString, name);
    if (value) return value;
  }
  return null;
}

function readCookieValue(cookieString: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of cookieString.split(';')) {
    const p = part.trim();
    if (p.startsWith(prefix)) {
      const raw = p.slice(prefix.length);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}