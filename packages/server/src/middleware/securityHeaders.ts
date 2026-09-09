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
 * 全局兜底安全头（§8 全响应类型覆盖）：Permissions-Policy + 对「未显式设 CSP」的
 * 响应（API 成功/错误、404/405、静态资源等）补 `default-src 'none'` CSP。HTML 页
 * 已在 consoleStatic 显式设 CSP，此处跳过不覆盖。
 *
 * 注意：必须以**根实例直接调用**（`globalSecurityHeaders(app)` 而非 `app.register`）——
 * register 会把本插件的 onSend 包进子封装作用域，只对其自身（空）路由生效，漏掉
 * 根上的 API/404/405/静态路由。
 */
export function globalSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', API_CSP_HEADER);
    }
    return payload;
  });
}