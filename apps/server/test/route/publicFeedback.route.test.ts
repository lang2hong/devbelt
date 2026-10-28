import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { publicFeedbackRoutes } from '../../src/modules/feedback/route/publicFeedback';
import { FeedbackService, hashReplyKey } from '../../src/modules/feedback/service/feedbackService';
import { RateLimitedError } from '../../src/domain/errors';
import { TokenService, type SigningKeys } from '../../src/service/tokenService';
import { EXTENSION_SCOPES } from '../../src/domain/enums';

const REPLY_KEY = 'A'.repeat(43);
const INSTALL_ID = 'install-1';

function makeRepo() {
  return {
    create: vi.fn(async () => 7),
    list: vi.fn(),
    updateStatusInTx: vi.fn(),
    overview: vi.fn(),
    findDetail: vi.fn(),
    listThread: vi.fn(async () => [
      {
        id: 7,
        category: 'bug' as const,
        content: 'hello',
        status: 'triaged' as const,
        createTime: new Date('2026-10-28T00:00:00Z'),
        replies: [{ id: 3, body: 'fixed', createTime: new Date('2026-10-28T01:00:00Z') }],
      },
    ]),
    findForReplyInTx: vi.fn(),
    createReplyInTx: vi.fn(),
    markTriagedIfNewInTx: vi.fn(),
    updateReplyEmail: vi.fn(),
  };
}

type UserState = { status: string; sessionVersion: number; role: 'user' | 'platform_admin' } | undefined;

async function build(opts: { rateLimit?: () => Promise<void>; user?: UserState; sessionActive?: boolean } = {}) {
  const app = Fastify();
  const repo = makeRepo();
  const service = new FeedbackService(repo as never);
  const rateLimiter = { hit: vi.fn(opts.rateLimit ?? (async () => undefined)) };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const user: UserState = 'user' in opts ? opts.user : { status: 'active', sessionVersion: 0, role: 'user' };
  await publicFeedbackRoutes(app, {
    service,
    rateLimiter: rateLimiter as never,
    tokenService,
    getUser: async () => user,
    getSessionActive: async () => opts.sessionActive ?? true,
  });
  const extToken = (userId = 42, aud: 'extension' | 'console' = 'extension') =>
    tokenService.signAccessToken({ userId, aud, scope: [...EXTENSION_SCOPES], sessionId: 's1', sessionVersion: 0 });
  return { app, repo, rateLimiter, extToken };
}

const body = {
  category: 'bug',
  content: '结果表格在窄窗口下横向滚动条消失',
  installId: INSTALL_ID,
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
      installId: INSTALL_ID,
      replyKeyHash: null,
    }));
  });

  it('带 replyKey 时只落 SHA-256 哈希', async () => {
    const { app, repo } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/db/feedback', payload: { ...body, replyKey: REPLY_KEY } });
    expect(res.statusCode).toBe(201);
    const saved = (repo.create.mock.calls as unknown as Array<[{ replyKeyHash: string }]>)[0]![0];
    expect(saved.replyKeyHash).toBe(hashReplyKey(REPLY_KEY));
    expect(JSON.stringify(saved)).not.toContain(REPLY_KEY);
  });

  it('有效扩展 token 关联账号', async () => {
    const { app, repo, extToken } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/db/feedback',
      headers: { authorization: `Bearer ${await extToken(42)}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 42 }));
  });

  it('无效 token 按匿名处理，不返回 401', async () => {
    const { app, repo } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/db/feedback',
      headers: { authorization: 'Bearer not-a-jwt' },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
  });

  it('console audience / 已禁用用户 / 会话失效均不关联账号', async () => {
    const consoleCase = await build();
    await consoleCase.app.inject({
      method: 'POST', url: '/api/db/feedback',
      headers: { authorization: `Bearer ${await consoleCase.extToken(42, 'console')}` }, payload: body,
    });
    expect(consoleCase.repo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));

    const disabled = await build({ user: { status: 'disabled', sessionVersion: 0, role: 'user' } });
    await disabled.app.inject({
      method: 'POST', url: '/api/db/feedback',
      headers: { authorization: `Bearer ${await disabled.extToken(42)}` }, payload: body,
    });
    expect(disabled.repo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));

    const revoked = await build({ sessionActive: false });
    await revoked.app.inject({
      method: 'POST', url: '/api/db/feedback',
      headers: { authorization: `Bearer ${await revoked.extToken(42)}` }, payload: body,
    });
    expect(revoked.repo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
  });

  it('body 里的 userId 不被信任（不能冒名）', async () => {
    const { app, repo } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/db/feedback', payload: { ...body, userId: 1 } });
    // Fastify 默认 removeAdditional：多余字段被剥离，账号只认服务端验证过的 token。
    expect(res.statusCode).toBe(201);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
  });

  it('按 IP 与安装 ID 双重限流', async () => {
    const { app, rateLimiter } = await build();
    await app.inject({ method: 'POST', url: '/api/db/feedback', payload: body });
    const keys = rateLimiter.hit.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(keys.some((k) => k.startsWith('feedback:ip:'))).toBe(true);
    expect(keys).toContain(`feedback:install:${INSTALL_ID}`);
  });

  it('超限返回 429', async () => {
    const { app } = await build({ rateLimit: async () => { throw new RateLimitedError(60); } });
    const res = await app.inject({ method: 'POST', url: '/api/db/feedback', payload: body });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('未知分类 / 非法 replyKey 被 schema 拦下（422）', async () => {
    const { app } = await build();
    const bad1 = await app.inject({ method: 'POST', url: '/api/db/feedback', payload: { ...body, category: 'spam' } });
    expect(bad1.statusCode).toBe(422);
    const bad2 = await app.inject({ method: 'POST', url: '/api/db/feedback', payload: { ...body, replyKey: 'short' } });
    expect(bad2.statusCode).toBe(422);
  });

  it('空内容被 service 拦下（422）', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/db/feedback', payload: { ...body, content: '   ' } });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /api/db/feedback/thread', () => {
  it('匿名凭证返回线程，且只用哈希查询', async () => {
    const { app, repo } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/db/feedback/thread',
      payload: { installId: INSTALL_ID, replyKey: REPLY_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      items: [{
        id: '7',
        category: 'bug',
        content: 'hello',
        status: 'triaged',
        createTime: '2026-10-28T00:00:00.000Z',
        replies: [{ id: '3', body: 'fixed', createTime: '2026-10-28T01:00:00.000Z' }],
      }],
    });
    expect(repo.listThread).toHaveBeenCalledWith({
      anonymous: { installId: INSTALL_ID, replyKeyHash: hashReplyKey(REPLY_KEY) },
      limit: 50,
    });
  });

  it('登录用户合并账号线程', async () => {
    const { app, repo, extToken } = await build();
    await app.inject({
      method: 'POST',
      url: '/api/db/feedback/thread',
      headers: { authorization: `Bearer ${await extToken(42)}` },
      payload: { installId: INSTALL_ID, replyKey: REPLY_KEY },
    });
    expect(repo.listThread).toHaveBeenCalledWith(expect.objectContaining({ userId: 42 }));
  });

  it('无任何凭证返回空列表，不查库', async () => {
    const { app, repo } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/db/feedback/thread', payload: { installId: INSTALL_ID } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
    expect(repo.listThread).not.toHaveBeenCalled();
  });

  it('线程接口单独限流', async () => {
    const { app, rateLimiter } = await build();
    await app.inject({ method: 'POST', url: '/api/db/feedback/thread', payload: { installId: INSTALL_ID, replyKey: REPLY_KEY } });
    const keys = rateLimiter.hit.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(keys.some((k) => k.startsWith('feedback:thread:ip:'))).toBe(true);
    expect(keys).toContain(`feedback:thread:install:${INSTALL_ID}`);
  });

  it('超限返回 429', async () => {
    const { app } = await build({ rateLimit: async () => { throw new RateLimitedError(60); } });
    const res = await app.inject({ method: 'POST', url: '/api/db/feedback/thread', payload: { installId: INSTALL_ID, replyKey: REPLY_KEY } });
    expect(res.statusCode).toBe(429);
  });
});
