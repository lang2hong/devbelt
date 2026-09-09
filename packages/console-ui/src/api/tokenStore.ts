/**
 * access token 模块内存存储（P3 §4.2）：仅内存，不落 localStorage/sessionStorage/IndexedDB。
 * 与 consoleAuth 解耦，供 authedFetch/session 复用而避免循环依赖。
 */

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}