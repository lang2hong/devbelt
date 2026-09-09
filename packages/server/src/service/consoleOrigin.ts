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

  if (isDev) {
    // 开发环境只允许 Vite loopback 源（localhost / 127.0.0.0/8 / ::1），
    // 拒绝把调试环境意外对外开放成可被跨域访问的任意源。
    if (!isLoopbackHostname(url.hostname)) {
      throw new Error(`SMTP_BASE_URL must be a loopback host in development: ${JSON.stringify(raw)}`);
    }
    return url.origin;
  }

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

/**
 * 开发环境的 loopback 主机判定：`localhost`、`::1`（含括号形）与 127.0.0.0/8。
 * WHATWG URL.hostname 对 IPv6 返回带方括号的 `[::1]`。
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  return /^127\./.test(hostname);
}

/**
 * 开发 CORS 允许的 Vite 源白名单（P3）：仅 http/https × loopback × 固定 5173。
 * 放行任意 loopback 端口会让本机任意服务获得同源 API 跨域读取能力，故必须收窄。
 */
const VITE_LOOPBACK_ORIGINS: ReadonlySet<string> = new Set([
  'http://localhost:5173',
  'https://localhost:5173',
  'http://127.0.0.1:5173',
  'https://127.0.0.1:5173',
  'http://[::1]:5173',
  'https://[::1]:5173',
]);

/**
 * CORS 允许的请求源解析：仅开发环境回显白名单内的 Vite loopback 5173 源（独立于
 * 邮件链接所用的、较宽的 resolveConsoleOrigin 策略）；其余环境（production / staging /
 * 未显式声明）一律返回 false，任何请求都不返回 Access-Control-Allow-Origin。
 */
export function resolveCorsOrigin(env: NodeJS.ProcessEnv = process.env): string | false {
  if (env.NODE_ENV !== 'development') return false;

  const raw = (env.SMTP_BASE_URL || '').trim() || 'http://localhost:5173';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`CORS origin must be a Vite loopback http(s)://<loopback>:5173 origin in development: ${JSON.stringify(raw)}`);
  }
  if (!VITE_LOOPBACK_ORIGINS.has(url.origin)) {
    throw new Error(`CORS origin must be a Vite loopback http(s)://<loopback>:5173 origin in development: ${JSON.stringify(raw)}`);
  }
  return url.origin;
}