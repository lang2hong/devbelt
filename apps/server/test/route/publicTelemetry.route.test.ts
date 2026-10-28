import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { publicTelemetryRoutes } from '../../src/modules/telemetry/route/publicTelemetry';
import { TelemetryService } from '../../src/modules/telemetry/service/telemetryService';
import { RateLimitedError } from '../../src/domain/errors';

const INSTALL_ID = '123e4567-e89b-42d3-a456-426614174000';

function makeRepo() {
  return {
    record: vi.fn(async () => undefined),
    overview: vi.fn(),
  };
}

async function build(rateLimit?: () => Promise<void>) {
  const app = Fastify();
  const repo = makeRepo();
  const service = new TelemetryService(repo as never);
  const rateLimiter = { hit: vi.fn(rateLimit ?? (async () => undefined)) };
  await publicTelemetryRoutes(app, { service, rateLimiter: rateLimiter as never });
  return { app, repo, rateLimiter };
}

const body = {
  installId: INSTALL_ID,
  appVersion: '0.4.1',
  os: 'linux',
  arch: 'x64',
  isRemote: false,
};

describe('POST /api/db/telemetry/heartbeat', () => {
  it('匿名心跳成功返回 204 并落库', async () => {
    const { app, repo } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/db/telemetry/heartbeat', payload: body });
    expect(res.statusCode).toBe(204);
    expect(repo.record).toHaveBeenCalledWith(expect.objectContaining({
      installId: INSTALL_ID,
      appVersion: '0.4.1',
      isRemote: false,
    }));
  });

  it('按 IP 与 installId 双重限流', async () => {
    const { app, rateLimiter } = await build();
    await app.inject({ method: 'POST', url: '/api/db/telemetry/heartbeat', payload: body });
    const keys = (rateLimiter.hit as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(keys.some((k) => k.startsWith('telemetry:ip:'))).toBe(true);
    expect(keys).toContain(`telemetry:install:${INSTALL_ID}`);
  });

  it('超限返回 429', async () => {
    const { app } = await build(async () => { throw new RateLimitedError(60); });
    const res = await app.inject({ method: 'POST', url: '/api/db/telemetry/heartbeat', payload: body });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('非法 installId 被 schema 拦下（422）', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/db/telemetry/heartbeat',
      payload: { ...body, installId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('空版本号被 schema 拦下（422）', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/db/telemetry/heartbeat',
      payload: { ...body, appVersion: '' },
    });
    expect(res.statusCode).toBe(422);
  });
});