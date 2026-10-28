import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { publicFeedbackRoutes } from '../../src/modules/feedback/route/publicFeedback';
import { FeedbackService } from '../../src/modules/feedback/service/feedbackService';
import { RateLimitedError } from '../../src/domain/errors';

function makeRepo() {
  return {
    create: vi.fn(async () => 7),
    list: vi.fn(),
    updateStatusInTx: vi.fn(),
    overview: vi.fn(),
  };
}

async function build(rateLimit?: () => Promise<void>) {
  const app = Fastify();
  const repo = makeRepo();
  const service = new FeedbackService(repo as never);
  const rateLimiter = { hit: vi.fn(rateLimit ?? (async () => undefined)) };
  await publicFeedbackRoutes(app, { service, rateLimiter: rateLimiter as never });
  return { app, repo, rateLimiter };
}

const body = {
  category: 'bug',
  content: '结果表格在窄窗口下横向滚动条消失',
  installId: 'install-1',
  appVersion: '0.4.1',
  os: 'linux/x64',
};

describe('POST /api/db/feedback', () => {
  it('匿名提交成功返回 201 与记录 id', async () => {
    const { app, repo } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/db/feedback', payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 7 });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: null,
      category: 'bug',
      installId: 'install-1',
    }));
  });

  it('按 IP 与安装 ID 双重限流', async () => {
    const { app, rateLimiter } = await build();
    await app.inject({ method: 'POST', url: '/api/db/feedback', payload: body });
    const keys = (rateLimiter.hit as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(keys.some((k) => k.startsWith('feedback:ip:'))).toBe(true);
    expect(keys).toContain('feedback:install:install-1');
  });

  it('超限返回 429', async () => {
    const { app } = await build(async () => { throw new RateLimitedError(60); });
    const res = await app.inject({ method: 'POST', url: '/api/db/feedback', payload: body });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('未知分类被 schema 拦下（400）', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/db/feedback',
      payload: { ...body, category: 'spam' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('空内容被 service 拦下（422）', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/db/feedback',
      payload: { ...body, content: '   ' },
    });
    expect(res.statusCode).toBe(422);
  });
});