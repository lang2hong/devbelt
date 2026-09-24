import type { FastifyHelmetOptions } from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

/** API 响应的严格 CSP（§8）：无任何资源加载来源。 */
const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

/**
 * 非 CSP 安全头（@fastify/helmet 选项）。
 *
 * P3 §8 修正：CSP 改为按响应类型分层 —— HTML（公开页/邮件页/SPA 壳）在 consoleStatic
 * 显式设 `self`-only CSP；API/404/405 等由 globalSecurityHeaders 兜底 `default-src
 * 'none'`。因此 helmet 的全局 CSP 关闭，其余头（nosniff/XFO/Referrer-Policy 等）保留。
 *
 * HSTS：生产强制 `max-age=31536000; includeSubDomains`（§8 L317），开发关闭
 * （直连 HTTP 的开发/内网发出 HSTS 会锁死浏览器，跟 §8 L330 一致）。
 */
export function securityHeaders(production = false): FastifyHelmetOptions {
  return {
    contentSecurityPolicy: false,
    hsts: production ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    xssFilter: false,
  };
}

/** API 默认 CSP 的兜底响应头 CORS 无关层。 */
const API_CSP_HEADER = API_CSP;

/**
 * 静态资源路径（auth-ui `/assets/`、db-ui `/db/assets/`、admin-ui `/admin/assets/`）。
 *
 * 静态资源**不补** `default-src 'none'`：页面/API 不受影响，但 **Worker 脚本的响应 CSP
 * 会作用于该 Worker 环境**——db-ui 的 Argon2 Web Worker 若带上 `default-src 'none'`，
 * `WebAssembly.compile` 会被拦截（P6-S5c）。
 */
const STATIC_ASSET_RE = /^\/(?:assets|db\/assets|admin\/assets)\//;

/**
 * 全局兜底安全头（§8 全响应类型覆盖）：Permissions-Policy + `/api/*` 的
 * `Cache-Control: no-store` + 对「未显式设 CSP」的响应补 `default-src 'none'` CSP。
 *
 * 单一 onSend 钩子：**本应用只允许这一个 onSend**——Fastify 5.12 下同一实例挂 ≥2 个
 * onSend 钩子会对响应触发 `ERR_HTTP_HEADERS_SENT`（表现为 `FST_ERR_REP_ALREADY_SENT`），
 * 故原 consoleAuth/linkFlows/paymentCallback 的 per-route Cache-Control 钩子已并入此处。
 *
 * 注意：必须以**根实例直接调用**（`globalSecurityHeaders(app)` 而非 `app.register`）——
 * register 会把本插件的 onSend 包进子封装作用域，只对其自身（空）路由生效，漏掉
 * 根上的 API/404/405/静态路由。
 */
export function globalSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.raw.headersSent) return payload; // 已发送（如 204）时不再改 header
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    const path = (req.url ?? '').split('?')[0];
    if (path.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (!STATIC_ASSET_RE.test(path) && !reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', API_CSP_HEADER);
    }
    return payload;
  });
}