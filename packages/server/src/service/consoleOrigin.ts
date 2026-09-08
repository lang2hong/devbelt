/**
 * 控制台 Origin 解析（独立成模块以便单独测试：config.ts 顶层会立即用 process.env 求值，
 * import 即可能抛错；本模块是纯函数，只接受显式 env 参数，与 signingKeys.js 同约定）。
 *
 * fail-closed：仅 `NODE_ENV === 'development'` 允许回退 `http://localhost:5173`（含 http）。
 * 其余环境（production / staging / 未显式声明）必须提供有效的绝对 HTTPS `SMTP_BASE_URL`，
 * 缺失 / 非法 / 非 HTTPS / 无可用 host 一律抛错——绝不静默落到 localhost。
 */
export function resolveConsoleOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const isDev = env.NODE_ENV === 'development';
  const raw = (env.SMTP_BASE_URL || '').trim().replace(/\/+$/, '');

  if (!raw) {
    if (isDev) return 'http://localhost:5173';
    throw new Error('SMTP_BASE_URL is required outside the local development profile');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    if (isDev) return 'http://localhost:5173';
    throw new Error(`SMTP_BASE_URL is not a valid absolute URL: ${JSON.stringify(raw)}`);
  }

  if (isDev) return url.origin;

  if (url.protocol !== 'https:') {
    throw new Error(`SMTP_BASE_URL must use https outside development: ${JSON.stringify(raw)}`);
  }
  if (!url.hostname) {
    throw new Error(`SMTP_BASE_URL has no usable host: ${JSON.stringify(raw)}`);
  }
  // SMTP_BASE_URL 是应用链接前缀（不是部署前缀）：带路径会产出服务端不托管、
  // 点了打不开的邮件链接（如 /some/path/verify-email）。只接受裸 origin。
  if (url.pathname !== '/') {
    throw new Error(`SMTP_BASE_URL must be a bare origin without a path: ${JSON.stringify(raw)}`);
  }
  if (url.search || url.hash) {
    throw new Error(`SMTP_BASE_URL must be a bare origin without query or fragment: ${JSON.stringify(raw)}`);
  }
  return url.origin;
}