import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { describe, expect, it } from 'vitest';
import { securityHeaders, globalSecurityHeaders } from '../../src/middleware/securityHeaders.js';

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(helmet, securityHeaders(false));
  // 根实例直接调用（非 register），使 onSend 覆盖 API/404/静态，而非子封装作用域。
  globalSecurityHeaders(app);
  app.get('/api/ok', async () => ({ ok: true }));
  app.get('/db/assets/worker.js', async (_req, reply) => {
    reply.type('application/javascript').send('/* worker */');
  });
  app.get('/page', async (_req, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'").type('text/html').send('<html></html>');
  });
  await app.ready();
  return app;
}

describe('globalSecurityHeaders (root-scoped header layering)', () => {
  it('applies API CSP + Permissions-Policy to API success', async () => {
    const app = await build();
    const api = await app.inject({ method: 'GET', url: '/api/ok' });
    expect(api.headers['content-security-policy']).toContain("default-src 'none'");
    expect(api.headers['permissions-policy']).toContain('camera=()');
    await app.close();
  });

  it('applies API CSP to Fastify 404 responses', async () => {
    const app = await build();
    const nf = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(nf.statusCode).toBe(404);
    expect(nf.headers['content-security-policy']).toContain("default-src 'none'");
    await app.close();
  });

  it('does not attach default-src none to static assets (worker CSP governs the worker env)', async () => {
    const app = await build();
    const asset = await app.inject({ method: 'GET', url: '/db/assets/worker.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-security-policy']).toBeUndefined();
    await app.close();
  });

  it('does not override an explicitly-set HTML CSP', async () => {
    const app = await build();
    const page = await app.inject({ method: 'GET', url: '/page' });
    expect(page.headers['content-security-policy']).toBe("default-src 'self'");
    await app.close();
  });
});