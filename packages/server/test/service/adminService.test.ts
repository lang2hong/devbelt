import { describe, it, expect } from 'vitest';
import { AdminService } from '../../src/service/adminService.js';
import { PlanPolicy, resolveEffectivePlans } from '../../src/policy/planPolicy.js';
import {
  FakeUserRepo,
  FakePlanRepo,
  FakeSubscriptionRepo,
  FakeRefreshTokenRepo,
  FakeSyncRepo,
  FakeDeviceRepo,
  FakeConnectionMetaRepo,
  
  
  FakeAdminAuditRepo,
  FakeOrganizationRepo,
  FakeMembershipRepo,
  FakeSeatRepo,
  FakeRegistrationRepo,
  makePlan,
} from '../helpers/fakeRepos.js';
import { EntityNotFoundError } from '../../src/domain/errors.js';

const DAY = 24 * 3600 * 1000;

async function setup() {
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([
    makePlan('free', { perSeatMaxDevices: 2 }),
    makePlan('pro', { perSeatMaxDevices: 0, perUserPrivateSyncQuotaBytes: 1024 }),
  ]);
  const subRepo = new FakeSubscriptionRepo();
  const orgRepo = new FakeOrganizationRepo();
  const membershipRepo = new FakeMembershipRepo();
  const seatRepo = new FakeSeatRepo();
  const registrationRepo = new FakeRegistrationRepo({
    users: userRepo, orgs: orgRepo, memberships: membershipRepo, subs: subRepo, seats: seatRepo, plans: planRepo,
  });
  const planPolicy = new PlanPolicy((id) => resolveEffectivePlans(id, { membershipRepo, subRepo, planRepo }));
  const rtRepo = new FakeRefreshTokenRepo();
  const syncRepo = new FakeSyncRepo();
  const deviceRepo = new FakeDeviceRepo();
  const connectionMetaRepo = new FakeConnectionMetaRepo();
  const auditRepo = new FakeAdminAuditRepo();
  const service = new AdminService(
    userRepo, planRepo, subRepo, membershipRepo, orgRepo, rtRepo, syncRepo,
    deviceRepo, connectionMetaRepo, auditRepo, planPolicy,
  );
  const { userId: adminId } = await registrationRepo.createAccount({ email: 'admin@example.com', passwordHash: 'h', role: 'admin' });
  const { userId: aliceId } = await registrationRepo.createAccount({ email: 'alice@example.com', passwordHash: 'h', role: 'user' });
  const admin = (await userRepo.findById(adminId))!;
  const alice = (await userRepo.findById(aliceId))!;
  const actor = { userId: admin.id, ip: '127.0.0.1' };
  return { service, userRepo, planRepo, subRepo, membershipRepo, orgRepo, rtRepo, syncRepo, deviceRepo, connectionMetaRepo, auditRepo, admin, alice, actor };
}

describe('AdminService.listUsers', () => {
  it('returns sanitized users without password hash', async () => {
    const { service, alice } = await setup();
    const rows = await service.listUsers(50, 0);
    expect(rows).toHaveLength(2);
    const row = rows.find((r) => r.id === alice.id)!;
    expect('passwordHash' in row).toBe(false);
  });

  it('counts users', async () => {
    const { service } = await setup();
    expect(await service.countUsers()).toBe(2);
  });
});

describe('AdminService.getUserDetail', () => {
  it('assembles user + plan + subscription + sessions + usage', async () => {
    const { service, rtRepo, syncRepo, deviceRepo, alice } = await setup();
    const t = await rtRepo.create({
      userId: alice.id, tokenHash: 'h1', deviceName: 'mac', ip: '1.2.3.4',
      expiresTime: new Date(Date.now() + DAY),
    });
    await rtRepo.updateLastUsed(t.id, new Date());
    await deviceRepo.upsert({ userId: alice.id, deviceId: 'dev1', hostname: 'mac' });
    await deviceRepo.bind(alice.id, 'dev1');
    await syncRepo.putSection(alice.id, 'connections', 'x'.repeat(10), 3);
    await syncRepo.putSection(alice.id, 'queries', 'y'.repeat(20), 1);

    const d = await service.getUserDetail(alice.id);
    expect(d.user.email).toBe('alice@example.com');
    expect(d.plan.code).toBe('free'); // personal org 的有效席位套餐
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

  it('lists subscriptions with organization name', async () => {
    const { service, membershipRepo, alice } = await setup();
    const m = (await membershipRepo.listByUser(alice.id)).find((x) => x.status === 'active')!;
    const rows = await service.listSubscriptions();
    const aliceRow = rows.find((r) => r.organizationId === m.organizationId)!;
    expect(aliceRow).toBeDefined();
    expect(aliceRow.organizationName).toBeDefined();
  });
});

describe('AdminService.updateUser', () => {
  it('updates role / status', async () => {
    const { service, userRepo, alice, actor } = await setup();
    await service.updateUser(alice.id, { role: 'admin', status: 'disabled' }, actor);
    const u = await userRepo.findById(alice.id);
    expect(u?.role).toBe('admin');
    expect(u?.status).toBe('disabled');
  });

  describe('枚举校验', () => {
    it('非法 role 抛 ValidationError 且不写库', async () => {
      const { service, userRepo, alice, actor } = await setup();
      await expect(
        service.updateUser(alice.id, { role: 'superadmin' as any }, actor),
      ).rejects.toThrow(/invalid role/);
      expect((await userRepo.findById(alice.id))?.role).toBe('user');
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
      expect((await userRepo.findById(alice.id))?.role).toBe('user');
    });

    it('空输入是合法的 no-op', async () => {
      const { service, alice, actor } = await setup();
      await expect(service.updateUser(alice.id, {}, actor)).resolves.toBeUndefined();
    });
  });
});