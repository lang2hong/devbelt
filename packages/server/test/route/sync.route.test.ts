import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import { SECTION_TYPES } from '../../src/domain/enums.js';

/**
 * 同步路由的 HTTP 层。
 *
 * 关键回归：`SECTION_TYPES` 此前定义了却在 src 中零使用 —— 服务端没有任何
 * section 白名单，非法值会作为参数进 SQL 并污染 `sync_sections.section`
 * VARCHAR(16)（超长在 strict 模式下报错 → 500）。
 */

let t: TestApp;
let token: string;
let userId: number;

beforeEach(async () => {
  t = await buildTestApp();
  const u = await t.makeUser();
  token = u.token;
  userId = u.id;
});
afterEach(async () => { await t.close(); });

describe('GET /api/sync', () => {
  it('无 token → 401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/sync' });
    expect(res.statusCode).toBe(401);
  });

  it('不带 section → 200（全节拉取）', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/sync', headers: t.auth(token) });
    expect(res.statusCode).toBe(200);
  });

  it.each([...SECTION_TYPES])('合法 section=%s → 200', async (section) => {
    const res = await t.app.inject({
      method: 'GET', url: `/api/sync?section=${section}`, headers: t.auth(token),
    });
    expect(res.statusCode).toBe(200);
  });

  it('非法 section → 400（白名单生效）', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/api/sync?section=evil', headers: t.auth(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('超长 section 不会打到 DB 列宽限制', async () => {
    const res = await t.app.inject({
      method: 'GET', url: `/api/sync?section=${'x'.repeat(64)}`, headers: t.auth(token),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/sync', () => {
  const base = { section: 'groups', encryptedData: 'cipher', baseVersion: 0 };

  it('缺 body → 400 而非 500', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/api/sync', headers: t.auth(token) });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).not.toContain('destructure');
  });

  it('合法推送 → 200', async () => {
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(token), payload: base,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(1);
  });

  /**
   * syncClient.pushSection 传的 itemCount/meta 在旧版本客户端里不存在，
   * JSON.stringify 会直接丢掉 undefined 的键 —— 因此这两个字段必须 optional，
   * 否则一次 schema 收紧会把已发布的客户端全部打断。
   */
  it('省略 itemCount/meta 仍然通过（向后兼容）', async () => {
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(token), payload: base,
    });
    expect(res.statusCode).toBe(200);
  });

  it('带 itemCount/meta 也通过', async () => {
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(token),
      payload: { ...base, itemCount: 3, meta: [{ uuid: 'a' }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('未声明的额外字段被忽略而非拒绝（不设 additionalProperties:false）', async () => {
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(token),
      payload: { ...base, futureField: 'from a newer client' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('baseVersion 非数字 → 400（此前会变成 NaN 一路进 SQL）', async () => {
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(token),
      payload: { ...base, baseVersion: 'abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('baseVersion 负数 → 400', async () => {
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(token),
      payload: { ...base, baseVersion: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('非法 section → 400', async () => {
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(token),
      payload: { ...base, section: 'evil' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('过期 baseVersion → 409 且带 version 供客户端对齐', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/sync', headers: t.auth(token), payload: base });
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(token),
      payload: { ...base, baseVersion: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT');
  });
});

describe('GET /api/sync/versions', () => {
  it('缺 section → 400（listVersions 必须指定）', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/api/sync/versions', headers: t.auth(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it('合法 section → 200', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/api/sync/versions?section=groups', headers: t.auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().versions)).toBe(true);
  });
});

describe('POST /api/sync/rollback', () => {
  it('缺 body → 400', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/sync/rollback', headers: t.auth(token),
    });
    expect(res.statusCode).toBe(400);
  });

  it('toVersion 非数字 → 400', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/sync/rollback', headers: t.auth(token),
      payload: { section: 'groups', toVersion: 'latest' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('不存在的版本 → 404', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/sync/rollback', headers: t.auth(token),
      payload: { section: 'groups', toVersion: 99 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('禁用用户访问已认证端点', () => {
  it('status=disabled → 403 USER_DISABLED', async () => {
    await t.repos.userRepo.updateStatus(userId, 'disabled');
    const res = await t.app.inject({ method: 'GET', url: '/api/sync', headers: t.auth(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('USER_DISABLED');
  });
});
