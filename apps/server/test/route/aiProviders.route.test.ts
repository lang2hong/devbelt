import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { aiProvidersRoutes } from '../../src/modules/ai/route/providers.js';
import { AiProviderService } from '../../src/modules/ai/service/aiProviderService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { MemoryAiProviderRepo } from '../helpers/fakeAiProviderRepo.js';
import { FakeRateLimitRepo } from '../helpers/fakeRepos.js';

async function build() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  const repo = new MemoryAiProviderRepo();
  repo.seed({ code: 'on', sortOrder: 1 });
  repo.seed({ code: 'off', status: 'disabled', sortOrder: 0 });
  await app.register(aiProvidersRoutes, { rateLimiter: new RateLimitService(new FakeRateLimitRepo(), false), providers: new AiProviderService(repo) });
  await app.ready();
  return app;
}

describe('GET /api/ai/providers（公开只读）', () => {
  it('无需登录；只返回启用项；带缓存头；不含 status', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ai/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age');
    const body = res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items.map((i) => i.code)).toEqual(['on']);
    expect(body.items[0]).not.toHaveProperty('status');
    expect(body.items[0]).toHaveProperty('baseUrl');
  });
});
