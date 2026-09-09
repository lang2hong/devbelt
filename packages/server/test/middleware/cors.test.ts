import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { describe, expect, it } from 'vitest';
import { resolveCorsOrigin } from '../../src/service/consoleOrigin.js';

async function build(origin: string | false): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin });
  app.get('/probe', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('cors origin policy', () => {
  it('development loopback origin is allowed (ACAO echoed)', async () => {
    const origin = resolveCorsOrigin({ NODE_ENV: 'development', SMTP_BASE_URL: 'http://localhost:5173' });
    expect(origin).toBe('http://localhost:5173');
    const app = await build(origin);
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    await app.close();
  });

  it('development: a foreign request origin is never reflected', async () => {
    const origin = resolveCorsOrigin({ NODE_ENV: 'development', SMTP_BASE_URL: 'http://localhost:5173' });
    const app = await build(origin);
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'http://evil.invalid' },
    });
    // 固定 allowlist：只回显配置的 loopback 源，绝不反射请求方 Origin（浏览器据此拒绝跨域）。
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).not.toBe('http://evil.invalid');
    await app.close();
  });

  it('production never returns Access-Control-Allow-Origin', async () => {
    const origin = resolveCorsOrigin({ NODE_ENV: 'production', SMTP_BASE_URL: 'https://console.example' });
    expect(origin).toBe(false);
    const app = await build(origin);
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://console.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('staging never returns Access-Control-Allow-Origin', async () => {
    const origin = resolveCorsOrigin({ NODE_ENV: 'staging', SMTP_BASE_URL: 'https://console.example' });
    expect(origin).toBe(false);
    const app = await build(origin);
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://console.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});