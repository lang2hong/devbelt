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
  const service = new AdminService(userRepo, planRepo, subRepo, rtRepo, syncRepo, deviceRepo, connectionMetaRepo, syncEventRepo, usageEventRepo);
  const admin = await userRepo.create('admin@example.com', 'h', 'admin', 'pro');
  const alice = await userRepo.create('alice@example.com', 'h', 'user', 'free');
  return { service, userRepo, planRepo, subRepo, rtRepo, syncRepo, deviceRepo, connectionMetaRepo, syncEventRepo, usageEventRepo, admin, alice };
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
    const { service, rtRepo, alice } = await setup();
    const t = await rtRepo.create({ userId: alice.id, tokenHash: 'h1', expiresTime: new Date(Date.now() + DAY) });
    await service.revokeSession(alice.id, t.id);
    expect(await service.listSessions(alice.id)).toHaveLength(0);
  });

  it('refuses to revoke another user session', async () => {
    const { service, rtRepo, alice, admin } = await setup();
    const t = await rtRepo.create({ userId: alice.id, tokenHash: 'h1', expiresTime: new Date(Date.now() + DAY) });
    await expect(service.revokeSession(admin.id, t.id)).rejects.toBeInstanceOf(EntityNotFoundError);
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
    const { service, userRepo, alice } = await setup();
    await service.updateUser(alice.id, { role: 'admin', planCode: 'pro', status: 'disabled' });
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
      const { service, userRepo, alice } = await setup();
      await expect(
        service.updateUser(alice.id, { role: 'superadmin' as any }),
      ).rejects.toThrow(/invalid role/);
      expect((await userRepo.findById(alice.id))?.role).toBe('user');
    });

    it('非法 planCode 抛错（防孤儿套餐码导致 /api/me 500）', async () => {
      const { service, userRepo, alice } = await setup();
      const before = (await userRepo.findById(alice.id))?.planCode;
      await expect(
        service.updateUser(alice.id, { planCode: 'enterprise' as any }),
      ).rejects.toThrow(/invalid planCode/);
      expect((await userRepo.findById(alice.id))?.planCode).toBe(before);
    });

    it('非法 status 抛错', async () => {
      const { service, alice } = await setup();
      await expect(
        service.updateUser(alice.id, { status: 'zombie' as any }),
      ).rejects.toThrow(/invalid status/);
    });

    it('校验先于任何写入：一个字段非法则整体不生效', async () => {
      const { service, userRepo, alice } = await setup();
      await expect(
        service.updateUser(alice.id, { role: 'admin', status: 'bogus' as any }),
      ).rejects.toThrow(/invalid status/);
      // role 合法但不应被写入 —— 避免部分生效（无事务，只能靠前置校验）
      expect((await userRepo.findById(alice.id))?.role).toBe('user');
    });

    it('空输入是合法的 no-op', async () => {
      const { service, alice } = await setup();
      await expect(service.updateUser(alice.id, {})).resolves.toBeUndefined();
    });
  });
});