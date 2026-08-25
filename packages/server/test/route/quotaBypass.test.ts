import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * 配额绕过。
 *
 * `maxConnections` 与 `maxDevices` 是 free/pro/team 三档套餐的两个核心分层维度，
 * 但服务端此前都拦不住：
 *
 * ## 连接数
 *
 * 校验写成 `if (section === 'connections' && input.meta)`，而 `meta` 是可选字段
 * （为兼容旧客户端）。三条独立的绕过路径：
 *  1. **不发 meta 就没有校验** —— 密文服务端不解析，无从察觉；
 *  2. 校验的是**入参条数**而非库内存量；
 *  3. `replaceAll` 名为「全量替换」，实现却只 upsert、**从不删除**入参里缺失的行，
 *     所以每次只发 1 条新 meta 就能让库内活跃行单调累加。
 *
 * ## 设备数
 *
 * `planPolicy.limit('devices')` 有实现、`DeviceLimitError` 有定义（还映射了 403），
 * `login` 的方法注释也写着「设备数检查」—— 但代码里没有任何计数或校验，
 * `DeviceLimitError` 在 src 下零引用。free 用户（maxDevices=1）可以在任意多台
 * 机器登录，一个账号供整个团队共用。
 *
 * ## 边界语义
 *
 * `check` 的判据是 `current >= limit`，这在「current = 新增之前的已用量」语义下
 * 正确；但调用方传的是**写入后的总量**，于是实际可用上限变成 `limit - 1`
 * （free 宣传 5 个连接，第 5 个就被拒，错误信息还写着 `5/5`）。
 */

let t: TestApp;
beforeEach(async () => { t = await buildTestApp(); });
afterEach(async () => { await t.close(); });

/** 造 n 条连接元数据 */
function metas(n: number, prefix = 'c'): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    connUuid: `${prefix}-${i}`, type: 'MYSQL', name: `conn-${i}`, enabled: true, deleted: false,
  }));
}

async function push(token: string, body: Record<string, unknown>) {
  return t.app.inject({ method: 'PUT', url: '/api/sync', headers: t.auth(token), payload: body });
}

describe('连接数配额：不发 meta 不能绕过校验', () => {
  it('connections 节缺少 meta → 400，而不是静默放行', async () => {
    const u = await t.makeUser();
    const res = await push(u.token, {
      section: 'connections', encryptedData: 'cipher', baseVersion: 0,
    });
    expect(res.statusCode).toBe(400);
  });

  it('其他 section 不要求 meta（不误伤）', async () => {
    const u = await t.makeUser();
    const res = await push(u.token, { section: 'groups', encryptedData: 'cipher', baseVersion: 0 });
    expect(res.statusCode).toBe(200);
  });
});

describe('连接数配额：按库内存量而非入参条数', () => {
  it('分多次每次只发 1 条，累计超限时被拒', async () => {
    // free 套餐 maxConnections = 5（makePlan 的默认值）
    const u = await t.makeUser();
    let version = 0;

    // 逐条累加到上限
    for (let i = 0; i < 5; i++) {
      const res = await push(u.token, {
        section: 'connections', encryptedData: `cipher-${i}`, baseVersion: version,
        meta: metas(i + 1),
      });
      expect(res.statusCode, `第 ${i + 1} 条应被接受`).toBe(200);
      version = res.json().version;
    }

    // 第 6 条：入参只有 6 条，但关键是库里已有 5 条 —— 必须被拒
    const over = await push(u.token, {
      section: 'connections', encryptedData: 'cipher-over', baseVersion: version,
      meta: metas(6),
    });
    expect(over.statusCode).toBe(403);
    expect(over.json().code).toBe('QUOTA_EXCEEDED');
  });

  it('恰好达到上限被接受（边界含等号，宣传 5 个就能用 5 个）', async () => {
    const u = await t.makeUser();
    const res = await push(u.token, {
      section: 'connections', encryptedData: 'cipher', baseVersion: 0, meta: metas(5),
    });
    expect(res.statusCode).toBe(200);
    expect(await t.repos.connectionMetaRepo.countActive(u.id)).toBe(5);
  });

  it('超过上限 1 条即被拒', async () => {
    const u = await t.makeUser();
    const res = await push(u.token, {
      section: 'connections', encryptedData: 'cipher', baseVersion: 0, meta: metas(6),
    });
    expect(res.statusCode).toBe(403);
  });

  it('墓碑（deleted）不计入活跃数', async () => {
    const u = await t.makeUser();
    const withTombstones = [
      ...metas(5),
      ...Array.from({ length: 10 }, (_, i) => ({
        connUuid: `dead-${i}`, type: 'MYSQL', enabled: false, deleted: true,
      })),
    ];
    const res = await push(u.token, {
      section: 'connections', encryptedData: 'cipher', baseVersion: 0, meta: withTombstones,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('replaceAll 是真的全量替换', () => {
  it('入参里缺失的连接被置为墓碑，活跃数随之下降', async () => {
    const u = await t.makeUser();
    const first = await push(u.token, {
      section: 'connections', encryptedData: 'c1', baseVersion: 0, meta: metas(5),
    });
    expect(await t.repos.connectionMetaRepo.countActive(u.id)).toBe(5);

    // 只上报 2 条 —— 另外 3 条在客户端已被删除
    const second = await push(u.token, {
      section: 'connections', encryptedData: 'c2', baseVersion: first.json().version, meta: metas(2),
    });
    expect(second.statusCode).toBe(200);
    expect(await t.repos.connectionMetaRepo.countActive(u.id)).toBe(2);
  });

  it('删除后腾出的额度可以重新使用（不会被幽灵行占住）', async () => {
    const u = await t.makeUser();
    let v = (await push(u.token, {
      section: 'connections', encryptedData: 'c1', baseVersion: 0, meta: metas(5, 'old'),
    })).json().version;

    // 全部删掉，换一批新的
    v = (await push(u.token, {
      section: 'connections', encryptedData: 'c2', baseVersion: v, meta: [],
    })).json().version;
    expect(await t.repos.connectionMetaRepo.countActive(u.id)).toBe(0);

    const res = await push(u.token, {
      section: 'connections', encryptedData: 'c3', baseVersion: v, meta: metas(5, 'new'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('返回的活跃数取自库内真值而非入参推算', async () => {
    const u = await t.makeUser();
    const n = await t.repos.connectionMetaRepo.replaceAll(u.id, metas(3) as any);
    expect(n).toBe(await t.repos.connectionMetaRepo.countActive(u.id));
  });
});

describe('设备数配额', () => {
  const creds = { email: 'dev@example.com', password: 'pw12345678' };

  async function register(headers: Record<string, string> = {}) {
    return t.app.inject({ method: 'POST', url: '/api/auth/register', headers, payload: creds });
  }
  async function login(deviceId: string) {
    return t.app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'x-device-id': deviceId }, payload: creds,
    });
  }
  async function pull(token: string, deviceId: string) {
    return t.app.inject({ method: 'GET', url: '/api/sync', headers: { ...t.auth(token), 'x-device-id': deviceId } });
  }

  it('free 套餐（maxDevices=1）第二台设备可登录但被同步层硬卡', async () => {
    await register({ 'x-device-id': 'device-1' });

    const second = await login('device-2');
    expect(second.statusCode).toBe(200);
    const sync = await pull(second.json().accessToken, 'device-2');
    expect(sync.statusCode).toBe(403);
    expect(sync.json().code).toBe('DEVICE_LIMIT_EXCEEDED');
  });

  it('同一设备重复登录不受限（顶掉旧会话，不叠加）', async () => {
    await register({ 'x-device-id': 'device-1' });

    const again = await login('device-1');
    expect(again.statusCode).toBe(200);
  });

  it('释放设备绑定后（revoke）新设备可同步', async () => {
    await register({ 'x-device-id': 'device-1' });
    // 释放设备 1 的绑定（不再靠撤销会话语义决定配额）
    await t.repos.deviceRepo.revoke(1, 'device-1');

    const res = await login('device-2');
    expect(res.statusCode).toBe(200);
    const sync = await pull(res.json().accessToken, 'device-2');
    expect(sync.statusCode).toBe(200);
  });

  it('maxDevices=0 表示无限，不做限制', async () => {
    // pro 套餐的 maxDevices 为 0
    await register({ 'x-device-id': 'd1' });
    await t.repos.userRepo.updatePlan(1, 'pro');
    await t.repos.refreshTokenRepo.revokeAllForUser(1);
    await t.app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'x-device-id': 'd1' }, payload: creds,
    });

    const res = await login('d2');
    expect(res.statusCode).toBe(200);
  });

  it('不带 deviceId 的登录不被设备配额拦住（旧客户端兼容）', async () => {
    await register({ 'x-device-id': 'device-1' });
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: creds });
    expect(res.statusCode).toBe(200);
  });
});
