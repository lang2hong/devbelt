import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { errorStatus, registerErrorHandler, sendError } from '../../src/middleware/errorHandler.js';
import {
  ConflictError,
  DomainError,
  EntityNotFoundError,
  InvalidCredentialsError,
  QuotaExceededError,
  TokenReuseError,
  UserDisabledError,
  ValidationError,
  VersionNotFoundError,
} from '../../src/domain/errors.js';

/**
 * errorStatus 是纯函数，此前零覆盖 —— 最容易测的东西反而没测。
 * registerErrorHandler 是本批新增的安全网，必须证明它不泄漏内部信息。
 */

describe('errorStatus', () => {
  it.each([
    ['INVALID_CREDENTIALS', 401],
    ['TOKEN_REUSE', 401],
    ['USER_DISABLED', 403],
    ['DEVICE_LIMIT_EXCEEDED', 403],
    ['SUBSCRIPTION_EXPIRED', 403],
    ['QUOTA_EXCEEDED', 403],
    ['NOT_FOUND', 404],
    ['VERSION_NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['VALIDATION_ERROR', 400],
    ['SOMETHING_UNKNOWN', 400],
  ])('%s → %i', (code, status) => {
    expect(errorStatus(code)).toBe(status);
  });

  it('每个 DomainError 子类的 code 都能映射到非 500', () => {
    const errors: DomainError[] = [
      new InvalidCredentialsError(),
      new TokenReuseError(1, 2),
      new UserDisabledError(1),
      new QuotaExceededError('sync_bytes', 10, 20),
      new EntityNotFoundError('user', 1),
      new VersionNotFoundError(1, 'groups', 3),
      new ConflictError(2, 1),
      new ValidationError('bad'),
    ];
    for (const e of errors) {
      expect(errorStatus(e.code), e.constructor.name).toBeLessThan(500);
    }
  });
});

describe('sendError', () => {
  function fakeReply() {
    const captured: { status?: number; body?: unknown } = {};
    const reply: any = {
      code(s: number) { captured.status = s; return reply; },
      send(b: unknown) { captured.body = b; return reply; },
    };
    return { reply, captured };
  }

  it('DomainError → 映射状态 + code', () => {
    const { reply, captured } = fakeReply();
    sendError(reply, new ConflictError(5, 3));
    expect(captured.status).toBe(409);
    expect(captured.body).toMatchObject({ code: 'CONFLICT' });
  });

  it('普通 Error → 500 固定文案，不泄漏 message', () => {
    const { reply, captured } = fakeReply();
    sendError(reply, new Error('ER_PARSE_ERROR near SELECT * FROM users WHERE token = "abc"'));
    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ message: 'Internal server error' });
  });

  it('非 Error 值也不崩', () => {
    const { reply, captured } = fakeReply();
    sendError(reply, 'just a string');
    expect(captured.status).toBe(500);
  });
});

describe('registerErrorHandler（全局安全网）', () => {
  async function appWith(handler: () => unknown) {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/boom', async () => handler());
    app.post('/schema', {
      schema: { body: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } },
    }, async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it('未捕获的普通 Error → 500，不回显 message', async () => {
    const app = await appWith(() => {
      throw new Error('ER_BAD_FIELD_ERROR: Unknown column password_hash');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ message: 'Internal server error' });
    expect(res.body).not.toContain('password_hash');
    await app.close();
  });

  it('未捕获的 DomainError → 按 code 映射', async () => {
    const app = await appWith(() => { throw new EntityNotFoundError('user', 7); });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    await app.close();
  });

  it('schema 校验失败 → 400 + VALIDATION_ERROR', async () => {
    const app = await appWith(() => ({}));
    const res = await app.inject({ method: 'POST', url: '/schema', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('body 不是合法 JSON → 400，不回显解析器细节', async () => {
    const app = await appWith(() => ({}));
    const res = await app.inject({
      method: 'POST', url: '/schema',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Bad request');
    await app.close();
  });

  it('404 → 固定结构，不回显请求路径', async () => {
    const app = await appWith(() => ({}));
    const res = await app.inject({ method: 'GET', url: '/secret-admin-panel' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'not found', code: 'NOT_FOUND' });
    expect(res.body).not.toContain('secret-admin-panel');
    await app.close();
  });
});
