import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { describe, expect, it } from 'vitest';
import { securityHeaders, globalSecurityHeaders } from '../../src/middleware/securityHeaders.js';
import { consoleAuthRoutes } from '../../src/modules/auth/route/consoleAuth.js';
const stubs = {
  csrfService: { issue: () => 't', verify: () => true, boundSession: () => undefined } as any,
  rateLimiter: { hit: async () => undefined } as any,
  consoleAuthService: { sessionIdOf: async () => undefined } as any,
  consoleOrigin: 'https://x', auditWriter: { write: () => undefined } as any,
  refreshMaxAgeSeconds: 3600, register: async () => ({ ok: true as const }),
};
describe('console auth 响应头（单 onSend 钩子回归）', () => {
  it('csrf 204 不再触发 ERR_HTTP_HEADERS_SENT，且带 no-store', async () => {
    const errs: string[] = [];
    const app = Fastify({ logger: { level: 'error', stream: { write: (s: string) => { errs.push(s); return true; } } } as any });
    await app.register(helmet, securityHeaders(false));
    globalSecurityHeaders(app);
    await app.register(async (child) => { await consoleAuthRoutes(child, stubs); });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/console/auth/csrf', headers: { accept: 'application/json' } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(errs).toEqual([]);
    await app.close();
  });
});
