import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

/**
 * 核证 Fastify v5 是否把路由级 `{ config: {...} }` 注入 `req.routeOptions.config`。
 *
 * per-route 收窄逻辑依赖它：
 * - `req.routeOptions.config.aud`（per-route audience 收窄）
 * - `req.routeOptions.config.permission`（路由所需权限码）
 *
 * 结论（实测 v5）：注入正常，`routeOptions.config` 含用户声明的 permission/aud，
 * 并额外合并了 route 的 method/url。收窄未静默失效（评审的 P0 担忧为假阳性）。
 */
describe('Fastify v5 req.routeOptions.config 注入', () => {
  it('onRequest hook 内可读到路由 config 的 permission 与 aud', async () => {
    const app = Fastify({ logger: false });
    let config: Record<string, unknown> = {};
    app.addHook('onRequest', async (req) => {
      config = (req.routeOptions as unknown as { config?: Record<string, unknown> }).config ?? {};
    });
    app.get('/api/items/:itemId', {
      config: { permission: 'resource.read', aud: 'extension' },
    }, async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/items/1' });
    expect(res.statusCode).toBe(200);
    expect(config.permission).toBe('resource.read');
    expect(config.aud).toBe('extension');
    await app.close();
  });

  it('未声明 config 的路由，config.permission / config.aud 为 undefined', async () => {
    const app = Fastify({ logger: false });
    let config: Record<string, unknown> = {};
    app.addHook('onRequest', async (req) => {
      config = (req.routeOptions as unknown as { config?: Record<string, unknown> }).config ?? {};
    });
    app.get('/api/plain', async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/plain' });
    expect(res.statusCode).toBe(200);
    expect(config.permission).toBeUndefined();
    expect(config.aud).toBeUndefined();
    await app.close();
  });
});