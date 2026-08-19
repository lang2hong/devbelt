import { describe, it, expect } from 'vitest';
import { AdminService } from '../../src/service/adminService.js';
import {
  FakeUserRepo,
  FakePlanRepo,
  FakeSubscriptionRepo,
  FakeRefreshTokenRepo,
  FakeSyncRepo,
  FakeDeviceRepo,
  FakeConnectionMetaRepo,
  FakeSyncEventRepo,
  FakeUsageEventRepo,
  FakeAdminAuditRepo,
  makePlan,
} from '../helpers/fakeRepos.js';
import { EntityNotFoundError } from '../../src/domain/errors.js';

const DAY = 24 * 3600 * 1000;

async function setup() {
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([
    makePlan('free', { maxDevices: 2 }),
    makePlan('pro', { maxDevices: 0, syncQuotaBytes: 1024 }),
  ]);
  const subRepo = new FakeSubscriptionRepo();
  const rtRepo = new FakeRefreshTokenRepo();
  const syncRepo = new FakeSyncRepo();
  const deviceRepo = new FakeDeviceRepo();
  const connectionMetaRepo = new FakeConnectionMetaRepo();
  const syncEventRepo = new FakeSyncEventRepo();
  const usageEventRepo = new FakeUsageEventRepo();
  const auditRepo = new FakeAdminAuditRepo();
  const service = new AdminService(userRepo, planRepo, subRepo, rtRepo, syncRepo, deviceRepo, connectionMetaRepo, syncEventRepo, usageEventRepo, auditRepo);
  const admin = await userRepo.create('admin@example.com', 'h', 'admin', 'pro');
  const alice = await userRepo.create('alice@example.com', 'h', 'user', 'free');
  // 管理操作都要带操作者（留痕 + 自伤防护的判据）。这里固定用 admin。
  const actor = { userId: admin.id, ip: '127.0.0.1' };
  return { service, userRepo, planRepo, subRepo, rtRepo, syncRepo, deviceRepo, connectionMetaRepo, syncEventRepo, usageEventRepo, auditRepo, admin, alice, actor };
}

describe('AdminService.listUsers', () => {
  it('returns sanitized users with subscription summary', async () => {
    const { service, subRepo, alice } = await setup();
    await subRepo.upsert({
      userId: alice.id, planCode: 'free', status: 'trialing',
      periodEndTime: new Date(Date.now() + DAY), provider: 'manual',
    });

    const rows = await service.listUsers(50, 0);
    expect(rows).toHaveLength(2);
    const row = rows.find((r) => r.id === alice.id)!;
    expect('passwordHash' in row).toBe(false);
    expect(row.subscription?.status).toBe('trialing');
    expect(row.subscription?.planCode).toBe('free');
  });

  it('counts users', async () => {
    const { service } = await setup();
    expect(await service.countUsers()).toBe(2);
  });

  /**
   * N+1 回归。
   *
   * 原实现在 `for (const user of users)` 里逐个 `subRepo.findByUserId(user.id)`。
   * admin-ui 固定请求 `limit=500`（且 paginationQuery 的上界正是 500），于是
   * 一次 `/admin/users` 是 `countUsers` 1 + `listAll` 1 + **500 次串行 findByUserId**
   * = 502 个往返，全程独占一条池连接。跨可用区 2ms RTT 就是 1 秒，10 个并发
   * admin 请求即打满 10 连接的池，第 11 个请求进入无上限队列挂死。
   *
   * 断言查询次数而不是断言耗时：假仓储没有 I/O 成本，只有调用计数能暴露这个缺陷。
   */
  it('批量取订阅，不按用户逐条查（N+1 回归）', async () => {
    const { service, subRepo, userRepo } = await setup();
    for (let i = 0; i < 20; i++) {
      const u = await userRepo.create(`bulk${i}@example.com`, 'scrypt$00$00', 'user', 'free');
      await subRepo.upsert({
        userId: u.id, planCode: 'pro', status: 'active',
        periodEndTime: new Date(Date.now() + DAY), provider: 'manual',
      });
    }
    subRepo.findByUserIdCalls = 0;
    subRepo.findByUserIdsCalls = 0;

    const rows = await service.listUsers(500, 0);

    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(subRepo.findByUserIdCalls).toBe(0);
    expect(subRepo.findByUserIdsCalls).toBe(1);
  });

  it('批量取订阅后，每个用户仍对应到自己的订阅（不串行也不串号）', async () => {
    const { service, subRepo, userRepo, alice } = await setup();
    const bob = await userRepo.create('bob2@example.com', 'scrypt$00$00', 'user', 'free');
    await subRepo.upsert({
      userId: alice.id, planCode: 'free', status: 'trialing',
      periodEndTime: new Date(Date.now() + DAY), provider: 'manual',
    });
    await subRepo.upsert({
      userId: bob.id, planCode: 'team', status: 'active',
      periodEndTime: new Date(Date.now() + DAY), provider: 'manual',
    });

    const rows = await service.listUsers(500, 0);
    expect(rows.find((r) => r.id === alice.id)!.subscription?.planCode).toBe('free');
    expect(rows.find((r) => r.id === bob.id)!.subscription?.planCode).toBe('team');
  });

  it('没有订阅的用户 subscription 为 undefined', async () => {
    const { service, userRepo } = await setup();
    const solo = await userRepo.create('solo@example.com', 'scrypt$00$00', 'user', 'free');
    const rows = await service.listUsers(500, 0);
    expect(rows.find((r) => r.id === solo.id)!.subscription).toBeUndefined();
  });

  it('空用户列表不发起批量查询', async () => {
    const { service, subRepo } = await setup();
    subRepo.findByUserIdsCalls = 0;
    const rows = await service.listUsers(500, 999);
    expect(rows).toHaveLength(0);
    expect(subRepo.findByUserIdsCalls).toBe(0);
  });
});

describe('AdminService.getUserDetail', () => {
  it('assembles user + plan + subscription + sessions + usage', async () => {
    const { service, subRepo, rtRepo, syncRepo, alice } = await setup();
    await subRepo.upsert({
      userId: alice.id, planCode: 'free', status: 'active',
      periodEndTime: new Date(Date.now() + DAY), provider: 'manual',
    });
    const t = await rtRepo.create({
      userId: alice.id, tokenHash: 'h1', deviceName: 'mac', ip: '1.2.3.4',
      expiresTime: new Date(Date.now() + DAY),
    });
    await rtRepo.updateLastUsed(t.id, new Date());
    await syncRepo.putSection(alice.id, 'connections', 'x'.repeat(10), 3);
    await syncRepo.putSection(alice.id, 'queries', 'y'.repeat(20), 1);

    const d = await service.getUserDetail(alice.id);
    expect(d.user.email).toBe('alice@example.com');
    expect(d.plan.code).toBe('free');
    expect(d.subscription?.status).toBe('active');
    expect(d.sessions).toHaveLength(1);
    expect(d.sessions[0].deviceName).toBe('mac');
    expect(d.usage.devices).toBe(1);
    expect(d.usage.syncBytes).toBe(30);
    expect(d.usage.sections).toEqual(expect.arrayContaining([
      { section: 'connections', version: 3, bytes: 10, updateTime: expect.any(Date) },
      { section: 'queries', version: 1, bytes: 20, updateTime: expect.any(Date) },
    ]));
  });

  it('throws NOT_FOUND for missing user', async () => {
    const { service } = await setup();
    await expect(service.getUserDetail(999)).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});

describe('AdminService sessions / plans / subscriptions', () => {
  it('lists plans', async () => {
    const { service } = await setup();
    const plans = await service.listPlans();
    expect(plans.map((p) => p.code).sort()).toEqual(['free', 'pro']);
  });

  it('lists active sessions for a user', async () => {
    const { service, rtRepo, alice } = await setup();
    await rtRepo.create({ userId: alice.id, tokenHash: 'h1', expiresTime: new Date(Date.now() + DAY) });
    const sessions = await service.listSessions(alice.id);
    expect(sessions).toHaveLength(1);
  });

  it('revokes a session that belongs to the user', async () => {
    const { service, rtRepo, alice, actor } = await setup();
    const t = await rtRepo.create({ userId: alice.id, tokenHash: 'h1', expiresTime: new Date(Date.now() + DAY) });
    await service.revokeSession(alice.id, t.id, actor);
    expect(await service.listSessions(alice.id)).toHaveLength(0);
  });

  it('refuses to revoke another user session', async () => {
    const { service, rtRepo, alice, admin, actor } = await setup();
    const t = await rtRepo.create({ userId: alice.id, tokenHash: 'h1', expiresTime: new Date(Date.now() + DAY) });
    await expect(service.revokeSession(admin.id, t.id, actor)).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('lists subscriptions with owner email', async () => {
    const { service, subRepo, alice } = await setup();
    await subRepo.upsert({
      userId: alice.id, planCode: 'pro', status: 'active',
      periodEndTime: new Date(Date.now() + DAY), provider: 'manual',
    });
    const rows = await service.listSubscriptions();
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('alice@example.com');
    expect(rows[0].planCode).toBe('pro');
  });
});

describe('AdminService.updateUser', () => {
  it('updates role/plan/status', async () => {
    const { service, userRepo, alice, actor } = await setup();
    await service.updateUser(alice.id, { role: 'admin', planCode: 'pro', status: 'disabled' }, actor);
    const u = await userRepo.findById(alice.id);
    expect(u?.role).toBe('admin');
    expect(u?.planCode).toBe('pro');
    expect(u?.status).toBe('disabled');
  });

  /**
   * 枚举白名单：路由 schema 与服务层是双层防护。
   *
   * 这些用例独立测服务层 —— 路由测试无法覆盖它（schema 会先拦下来），
   * 而 `UpdateUserInput` 的字段是 TS 联合类型，编译期约束在运行时不存在。
   * 任何绕过路由的调用方（脚本、将来的内部接口）都要靠这一层。
   */
  describe('枚举校验', () => {
    it('非法 role 抛 ValidationError 且不写库', async () => {
      const { service, userRepo, alice, actor } = await setup();
      await expect(
        service.updateUser(alice.id, { role: 'superadmin' as any }, actor),
      ).rejects.toThrow(/invalid role/);
      expect((await userRepo.findById(alice.id))?.role).toBe('user');
    });

    it('非法 planCode 抛错（防孤儿套餐码导致 /api/me 500）', async () => {
      const { service, userRepo, alice, actor } = await setup();
      const before = (await userRepo.findById(alice.id))?.planCode;
      await expect(
        service.updateUser(alice.id, { planCode: 'enterprise' as any }, actor),
      ).rejects.toThrow(/invalid planCode/);
      expect((await userRepo.findById(alice.id))?.planCode).toBe(before);
    });

    it('非法 status 抛错', async () => {
      const { service, alice, actor } = await setup();
      await expect(
        service.updateUser(alice.id, { status: 'zombie' as any }, actor),
      ).rejects.toThrow(/invalid status/);
    });

    it('校验先于任何写入：一个字段非法则整体不生效', async () => {
      const { service, userRepo, alice, actor } = await setup();
      await expect(
        service.updateUser(alice.id, { role: 'admin', status: 'bogus' as any }, actor),
      ).rejects.toThrow(/invalid status/);
      // role 合法但不应被写入 —— 避免部分生效（无事务，只能靠前置校验）
      expect((await userRepo.findById(alice.id))?.role).toBe('user');
    });

    it('空输入是合法的 no-op', async () => {
      const { service, alice, actor } = await setup();
      await expect(service.updateUser(alice.id, {}, actor)).resolves.toBeUndefined();
    });
  });
});