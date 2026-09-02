import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerErrorHandler, sendError } from '../../src/middleware/errorHandler.js';
import { OrganizationNotFoundError, RateLimitedError } from '../../src/domain/errors.js';

/**
 * sendError 只映射 DomainError；未知异常必须冒泡到全局 errorHandler，
 * 由那里记录日志后回固定 500（否则生产上只剩一条无上下文的 500）。
 */
async function buildApp() {
  const logged: unknown[] = [];
  const app = Fastify({ logger: false });
  registerErrorHandler(app);

  app.addHook('onRequest', async (req) => {
    req.log.error = ((...args: unknown[]) => {
      logged.push(args[0]);
      return req.log;
    }) as typeof req.log.error;
  });

  app.get('/domain', async (_req, reply) => {
    try {
      throw new OrganizationNotFoundError();
    } catch (e) {
      sendError(reply, e);
    }
  });

  app.get('/rate-limited', async (_req, reply) => {
    try {
      throw new RateLimitedError(42);
    } catch (e) {
      sendError(reply, e);
    }
  });

  app.get('/unknown', async (_req, reply) => {
    try {
      throw new Error('boom: internal detail');
    } catch (e) {
      sendError(reply, e);
    }
  });

  await app.ready();
  return { app, logged };
}

describe('sendError', () => {
  it('maps DomainError to its HTTP status and code', async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/domain' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
    } finally {
      await app.close();
    }
  });

  it('keeps Retry-After for rate limiting', async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/rate-limited' });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('42');
    } finally {
      await app.close();
    }
  });

  it('rethrows unknown errors so the global handler logs them, and hides details', async () => {
    const { app, logged } = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/unknown' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ message: 'Internal server error' });
      expect(res.body).not.toContain('internal detail');
      expect(logged).toHaveLength(1);
      expect((logged[0] as { err: Error }).err.message).toBe('boom: internal detail');
    } finally {
      await app.close();
    }
  });
});
