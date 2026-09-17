/**
 * access token 存储（P3 §4.2）：sessionStorage 会话级存储 —— 刷新页面保留、关闭标签页即清。
 *
 * 此前用模块内存（刷新即丢），导致每次刷新页面都触发一次 refresh（csrf + refresh 两次
 * 往返，约 1s）。access token 是短期令牌（15min），refresh token 恒在 HttpOnly cookie
 * （XSS 不可读），因此把短期 access token 放 sessionStorage 不扩大泄漏面；SSR / 不可用
 * 环境回退模块内存。
 */

const KEY = 'devbelt.console.accessToken';
let memoryToken: string | null = null;

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

export function getAccessToken(): string | null {
  const s = storage();
  if (!s) return memoryToken;
  try {
    return s.getItem(KEY);
  } catch {
    return memoryToken;
  }
}

export function setAccessToken(token: string | null): void {
  memoryToken = token;
  const s = storage();
  if (!s) return;
  try {
    if (token === null) s.removeItem(KEY);
    else s.setItem(KEY, token);
  } catch {
    // 隐私模式等 storage 不可写时静默忽略；内存副照仍在。
  }
}