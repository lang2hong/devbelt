import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import { DEVICE_HEADER_LIMITS, readDeviceHeaders } from '../../src/route/deviceHeaders.js';
import { MAX_SECTION_BYTES } from '../../src/route/schemas.js';

/**
 * 设备请求头的长度收敛。
 *
 * 这些头会直接落进窄 VARCHAR 列（`refresh_tokens.device_id` 是 VARCHAR(64)、
 * `devices.hostname` 是 VARCHAR(120)、`user_agent` 是 VARCHAR(255)……）。
 * MySQL 8 默认 `sql_mode` 含 STRICT_TRANS_TABLES，超长不是截断而是
 * `ER_DATA_TOO_LONG` —— 于是：
 *
 *  - 登录：`deviceRepo.upsert` 抛错 → 500，用户根本登不上。而 300 字符的
 *    User-Agent 在真实世界里是存在的（某些代理/客户端），那类用户会遇到
 *    「无论如何都登不上」且日志里只有一行 SQL 错误。
 *  - 推送：`PUT /api/sync` 的写入顺序是「先写 section（版本 N→N+1 已提交）→
 *    再写 sync_events」。后者因超长 device_id 抛错时前者不回滚，客户端拿到 500
 *    因而不更新本地 base，下次推送 base=N 而服务端已是 N+1 → **永久 409**。
 *
 * 选择截断而不是返回 400：`user-agent` 不由用户意图决定，为它拒绝登录是错的；
 * 而 `x-device-id` 若在一处截断、另一处 400，同一个客户端会在不同端点得到
 * 不一致的结果。统一截断则同一个超长 id 在所有端点收敛到同一个值，设备判同
 * 仍然成立。
 *
 * 注意：内存假仓储不模拟列宽，所以「超长会 500」这件事在路由测试里**不可见**。
 * 下面的单元测试直接断言截断结果，这是本文件的主要防线；HTTP 层用例只保证
 * 截断接进了三条真实路径。
 */
describe('readDeviceHeaders（截断到列宽）', () => {
  it('每个字段按各自列宽截断', () => {
    const long = 'x'.repeat(1000);
    const headers: Record<string, any> = {
      'x-device-name': long,
      'x-device-id': long,
      'x-device-machine-id': long,
      'x-device-hostname': long,
      'x-device-os': long,
      'x-device-arch': long,
      'x-device-os-version': long,
      'x-device-app': long,
      'x-device-app-version': long,
      'x-device-remote': long,
      'x-device-language': long,
      'x-device-timezone': long,
      'user-agent': long,
    };
    const d = readDeviceHeaders({ headers, ip: '1.2.3.4' });

    expect(d.deviceName).toHaveLength(DEVICE_HEADER_LIMITS.deviceName);
    expect(d.deviceId).toHaveLength(DEVICE_HEADER_LIMITS.deviceId);
    expect(d.machineId).toHaveLength(DEVICE_HEADER_LIMITS.machineId);
    expect(d.hostname).toHaveLength(DEVICE_HEADER_LIMITS.hostname);
    expect(d.os).toHaveLength(DEVICE_HEADER_LIMITS.os);
    expect(d.arch).toHaveLength(DEVICE_HEADER_LIMITS.arch);
    expect(d.osVersion).toHaveLength(DEVICE_HEADER_LIMITS.osVersion);
    expect(d.appName).toHaveLength(DEVICE_HEADER_LIMITS.appName);
    expect(d.appVersion).toHaveLength(DEVICE_HEADER_LIMITS.appVersion);
    expect(d.remoteName).toHaveLength(DEVICE_HEADER_LIMITS.remoteName);
    expect(d.language).toHaveLength(DEVICE_HEADER_LIMITS.language);
    expect(d.timezone).toHaveLength(DEVICE_HEADER_LIMITS.timezone);
    expect(d.userAgent).toHaveLength(DEVICE_HEADER_LIMITS.userAgent);
  });

  it('上界与 schema.ts 的列宽一致', () => {
    // 对齐 refresh_tokens.device_id / devices.hostname / refresh_tokens.user_agent
    expect(DEVICE_HEADER_LIMITS.deviceId).toBe(64);
    expect(DEVICE_HEADER_LIMITS.deviceName).toBe(120);
    expect(DEVICE_HEADER_LIMITS.hostname).toBe(120);
    expect(DEVICE_HEADER_LIMITS.userAgent).toBe(255);
    expect(DEVICE_HEADER_LIMITS.arch).toBe(16);
    expect(DEVICE_HEADER_LIMITS.language).toBe(16);
  });

  it('未超长的值原样保留', () => {
    const d = readDeviceHeaders({
      headers: { 'x-device-id': 'dev-1', 'x-device-name': 'MacBook' },
      ip: '1.2.3.4',
    });
    expect(d.deviceId).toBe('dev-1');
    expect(d.deviceName).toBe('MacBook');
  });

  it('缺失的头返回 undefined，不返回空串', () => {
    const d = readDeviceHeaders({ headers: {}, ip: '1.2.3.4' });
    expect(d.deviceId).toBeUndefined();
    expect(d.userAgent).toBeUndefined();
  });

  it('非字符串头（数组形式）按 undefined 处理，不抛错', () => {
    const d = readDeviceHeaders({ headers: { 'x-device-id': ['a', 'b'] }, ip: '1.2.3.4' });
    expect(d.deviceId).toBeUndefined();
  });

  it('ip 取 req.ip，不接受客户端自述', () => {
    const d = readDeviceHeaders({ headers: { 'x-device-ip': '9.9.9.9' }, ip: '1.2.3.4' });
    expect(d.ip).toBe('1.2.3.4');
  });

  it('同一个超长 id 在不同请求上收敛到同一个值（设备判同仍成立）', () => {
    const long = 'd'.repeat(200);
    const a = readDeviceHeaders({ headers: { 'x-device-id': long }, ip: '1.1.1.1' });
    const b = readDeviceHeaders({ headers: { 'x-device-id': long }, ip: '2.2.2.2' });
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.deviceId).toHaveLength(64);
  });
});

describe('三条真实路径都接上了截断（断言落库值，不只看状态码）', () => {
  let t: TestApp;
  let token: string;

  const HUGE = {
    'x-device-id': 'x'.repeat(1000),
    'x-device-name': 'n'.repeat(1000),
    'user-agent': 'u'.repeat(1000),
  };

  beforeEach(async () => {
    t = await buildTestApp();
    token = (await t.makeUser()).token;
  });
  afterEach(async () => { await t.close(); });

  it('注册：落库的 device_id / device_name / user_agent 均已收敛到列宽', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register', headers: HUGE,
      payload: { email: 'huge@example.com', password: 'pw12345678' },
    });
    expect(res.statusCode).toBe(201);

    // 假仓储不模拟列宽，所以状态码不能作为判据 —— 必须看真正写进去的值
    const session = [...t.repos.refreshTokenRepo.tokens.values()].at(-1)!;
    expect(session.deviceId).toHaveLength(DEVICE_HEADER_LIMITS.deviceId);
    expect(session.deviceName).toHaveLength(DEVICE_HEADER_LIMITS.deviceName);
    expect(session.userAgent).toHaveLength(DEVICE_HEADER_LIMITS.userAgent);

    const device = [...t.repos.deviceRepo.devices.values()].at(-1)!;
    expect(device.deviceId).toHaveLength(DEVICE_HEADER_LIMITS.deviceId);
  });

  it('登录：同样收敛，且与注册时的 deviceId 一致（设备判同不被截断破坏）', async () => {
    await t.app.inject({
      method: 'POST', url: '/api/auth/register', headers: HUGE,
      payload: { email: 'huge2@example.com', password: 'pw12345678' },
    });
    const registeredId = [...t.repos.deviceRepo.devices.values()].at(-1)!.deviceId;

    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/login', headers: HUGE,
      payload: { email: 'huge2@example.com', password: 'pw12345678' },
    });
    expect(res.statusCode).toBe(200);

    // 同一台设备重登不应因截断而被认成新设备（否则 revokeByDevice 顶不掉旧会话）
    expect(t.repos.deviceRepo.devices.size).toBe(1);
    expect([...t.repos.deviceRepo.devices.values()][0].deviceId).toBe(registeredId);
  });

  it('推送：sync_events 里的 device_id 已收敛，且版本可连续推进', async () => {
    const headers = { ...t.auth(token), 'x-device-id': 'y'.repeat(500) };

    const first = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers,
      payload: { section: 'groups', encryptedData: 'cipher-1', baseVersion: 0 },
    });
    expect(first.statusCode).toBe(200);
    const v1 = first.json().version;

    expect(t.repos.syncEventRepo.events.at(-1)!.deviceId)
      .toHaveLength(DEVICE_HEADER_LIMITS.deviceId);

    // 真库上留痕写失败会让第一次变 500，客户端本地 base 不前进 → 这里就是 409
    const second = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers,
      payload: { section: 'groups', encryptedData: 'cipher-2', baseVersion: v1 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().version).toBe(v1 + 1);
  });

  it('用量上报：usage_events 里的 device_id 已收敛', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/usage',
      headers: { ...t.auth(token), 'x-device-id': 'z'.repeat(300) },
      payload: { connectionOpens: 1, queryExecutes: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(t.repos.usageEventRepo.events.at(-1)!.deviceId)
      .toHaveLength(DEVICE_HEADER_LIMITS.deviceId);
  });

  it('拉取：sync_events 里的 device_id 已收敛', async () => {
    // pull 只对已存在的 section 留痕，所以先推一节
    await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(token),
      payload: { section: 'groups', encryptedData: 'cipher', baseVersion: 0 },
    });

    const res = await t.app.inject({
      method: 'GET', url: '/api/sync',
      headers: { ...t.auth(token), 'x-device-id': 'p'.repeat(300) },
    });
    expect(res.statusCode).toBe(200);

    const pullEvent = t.repos.syncEventRepo.events.filter((e) => e.direction === 'pull').at(-1)!;
    expect(pullEvent.deviceId).toHaveLength(DEVICE_HEADER_LIMITS.deviceId);
  });
});

/**
 * 请求体上限的作用域。
 *
 * 放宽 bodyLimit 必须是**逐路由**的。只有 `PUT /api/sync` 的 body 里装着整节
 * 全量密文；`/api/auth/login`、`/api/auth/register` 这类未认证端点只需要几百
 * 字节，让它们也接受 8MB 纯粹是白送攻击面。
 *
 * 这组用例把作用域钉住：同一个 2 MiB 请求体，同步端点接受、登录端点以 413 拒绝。
 * 若哪天有人为了图省事把全局 bodyLimit 抬高，第二条会立刻红。
 */
describe('bodyLimit 的作用域', () => {
  let t: TestApp;
  beforeEach(async () => { t = await buildTestApp(); });
  afterEach(async () => { await t.close(); });

  it('同步端点接受 2 MiB 密文（超出全局 1 MiB，靠路由级放宽）', async () => {
    const u = await t.makeUser();
    // free 的 syncQuotaBytes 是 1MiB，会先撞配额（403）而测不到 bodyLimit；
    // 用 team（1GiB）把配额这一层排除，专门验证请求体上限
    await t.repos.userRepo.updatePlan(u.id, 'team');
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(u.token),
      payload: { section: 'groups', encryptedData: 'a'.repeat(2 * 1024 * 1024), baseVersion: 0 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('登录端点拒绝同样大小的请求体（未认证端点不该被放宽）', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'a@b.com', password: 'x'.repeat(2 * 1024 * 1024) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('注册端点同样拒绝', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'a@b.com', password: 'x'.repeat(2 * 1024 * 1024) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('超过单节上限的密文以 400 拒绝（schema 层，不打到数据库）', async () => {
    const u = await t.makeUser();
    await t.repos.userRepo.updatePlan(u.id, 'team');
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(u.token),
      payload: {
        section: 'groups',
        encryptedData: 'a'.repeat(MAX_SECTION_BYTES + 1),
        baseVersion: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
