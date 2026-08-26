import { describe, expect, it, beforeEach } from 'vitest';
import { AdminService } from '../../src/service/adminService.js';
import { PlanPolicy } from '../../src/policy/planPolicy.js';
import {
  FakeAdminAuditRepo,
  FakeConnectionMetaRepo,
  FakeDeviceRepo,
  FakePlanRepo,
  FakeRefreshTokenRepo,
  FakeSubscriptionRepo,
  
  FakeSyncRepo,
  
  FakeUserRepo,
  FakeOrganizationRepo,
  FakeMembershipRepo,
  makePlan,
} from '../helpers/fakeRepos.js';
import { ValidationError } from '../../src/domain/errors.js';

/**
 * 管理端的两类硬性约束：**不可自伤** 与 **留痕**。
 * 自伤不可逆；无痕的提权是审计黑洞。
 */

interface Ctx {
  service: AdminService;
  userRepo: FakeUserRepo;
  planRepo: FakePlanRepo;
  auditRepo: FakeAdminAuditRepo;
  rtRepo: FakeRefreshTokenRepo;
}

async function setup(): Promise<Ctx & { admin: { id: number }; other: { id: number } }> {
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([
    makePlan('free', { perUserMaxPrivateConnections: 5 }),
    makePlan('pro', { perUserMaxPrivateConnections: 50 }),
    makePlan('team', { perUserMaxPrivateConnections: 500 }),
  ]);
  const subRepo = new FakeSubscriptionRepo();
  const rtRepo = new FakeRefreshTokenRepo();
  const syncRepo = new FakeSyncRepo();
  const deviceRepo = new FakeDeviceRepo();
  const connectionMetaRepo = new FakeConnectionMetaRepo();
  const auditRepo = new FakeAdminAuditRepo();
  const orgRepo = new FakeOrganizationRepo();
  const membershipRepo = new FakeMembershipRepo();
  const planPolicy = new PlanPolicy(async () => []);
  const service = new AdminService(
    userRepo, planRepo, subRepo, membershipRepo, orgRepo, rtRepo, syncRepo,
    deviceRepo, connectionMetaRepo, auditRepo, planPolicy,
  );
  const admin = await userRepo.create('admin@example.com', 'scrypt$x$y', 'admin');
  const other = await userRepo.create('user@example.com', 'scrypt$x$y', 'user');
  return { service, userRepo, planRepo, auditRepo, rtRepo, admin, other };
}

/** 操作者上下文。ip 只用于留痕，不参与判定。 */
const actor = (id: number) => ({ userId: id, ip: '10.0.0.1' });

let c: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { c = await setup(); });

describe('AdminService.updateUser 自伤防护', () => {
  it('拒绝把自己降级为普通用户', async () => {
    await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin');

    await expect(c.service.updateUser(c.admin.id, { role: 'user' }, actor(c.admin.id)))
      .rejects.toBeInstanceOf(ValidationError);
    expect((await c.userRepo.findById(c.admin.id))!.role).toBe('admin');
  });

  it('拒绝把自己禁用', async () => {
    await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin');

    await expect(c.service.updateUser(c.admin.id, { status: 'disabled' }, actor(c.admin.id)))
      .rejects.toBeInstanceOf(ValidationError);
    expect((await c.userRepo.findById(c.admin.id))!.status).toBe('active');
  });

  it('允许把自己的 role 原样写回 admin（幂等提交不该报错）', async () => {
    await c.service.updateUser(c.admin.id, { role: 'admin' }, actor(c.admin.id));
    expect((await c.userRepo.findById(c.admin.id))!.role).toBe('admin');
  });

  it('允许改别人的 role 与 status', async () => {
    await c.service.updateUser(c.other.id, { role: 'admin', status: 'disabled' }, actor(c.admin.id));
    const u = (await c.userRepo.findById(c.other.id))!;
    expect(u.role).toBe('admin');
    expect(u.status).toBe('disabled');
  });
});

describe('AdminService.updateUser 最后一个 admin 保护', () => {
  it('拒绝降级仅存的 admin（即使操作者是另一个人）', async () => {
    const a2 = await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin');
    await c.service.updateUser(a2.id, { role: 'user' }, actor(c.admin.id));
    expect(await c.userRepo.countAdmins()).toBe(1);

    await expect(c.service.updateUser(c.admin.id, { role: 'user' }, actor(a2.id)))
      .rejects.toThrow(/last admin|最后/i);
    expect((await c.userRepo.findById(c.admin.id))!.role).toBe('admin');
  });

  it('拒绝禁用仅存的 admin', async () => {
    const a2 = await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin');
    await c.service.updateUser(a2.id, { role: 'user' }, actor(c.admin.id));

    await expect(c.service.updateUser(c.admin.id, { status: 'disabled' }, actor(a2.id)))
      .rejects.toThrow(/last admin|最后/i);
    expect((await c.userRepo.findById(c.admin.id))!.status).toBe('active');
  });

  it('还剩两个 admin 时可以降级其中一个', async () => {
    const a2 = await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin');
    await c.service.updateUser(a2.id, { role: 'user' }, actor(c.admin.id));
    expect((await c.userRepo.findById(a2.id))!.role).toBe('user');
  });

  it('禁用一个非 admin 用户不受该规则影响', async () => {
    await c.service.updateUser(c.other.id, { status: 'disabled' }, actor(c.admin.id));
    expect((await c.userRepo.findById(c.other.id))!.status).toBe('disabled');
  });
});

describe('管理操作留痕', () => {
  it('改 role / status 各留一条记录，含旧值与新值', async () => {
    await c.service.updateUser(c.other.id, { role: 'admin', status: 'disabled' }, actor(c.admin.id));

    const rows = c.auditRepo.rows.filter((r) => r.action === 'user.update');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.actorUserId).toBe(c.admin.id);
    expect(row.targetType).toBe('user');
    expect(row.targetId).toBe(String(c.other.id));
    expect(row.ip).toBe('10.0.0.1');
    expect(row.detail).toMatchObject({
      role: { from: 'user', to: 'admin' },
      status: { from: 'active', to: 'disabled' },
    });
  });

  it('只记实际改动的字段，没传的字段不出现在 detail 里', async () => {
    await c.service.updateUser(c.other.id, { status: 'disabled' }, actor(c.admin.id));
    const [row] = c.auditRepo.rows;
    expect(Object.keys(row.detail)).toEqual(['status']);
  });

  it('被拒绝的操作不留痕（没发生的事不该出现在审计里）', async () => {
    await expect(c.service.updateUser(c.other.id, { role: 'root' as any }, actor(c.admin.id)))
      .rejects.toBeInstanceOf(ValidationError);
    expect(c.auditRepo.rows).toHaveLength(0);
  });

  it('审计写入失败时拒绝执行操作', async () => {
    c.auditRepo.failNext = true;
    await expect(c.service.updateUser(c.other.id, { status: 'disabled' }, actor(c.admin.id)))
      .rejects.toThrow(/audit/i);
    expect((await c.userRepo.findById(c.other.id))!.status).toBe('active');
  });

  it('吊销会话留痕', async () => {
    const s = await c.rtRepo.create({
      userId: c.other.id, tokenHash: 'h1', expiresTime: new Date(Date.now() + 86400_000),
    });
    await c.service.revokeSession(c.other.id, s.id, actor(c.admin.id));

    const [row] = c.auditRepo.rows;
    expect(row.action).toBe('session.revoke');
    expect(row.targetType).toBe('session');
    expect(row.targetId).toBe(String(s.id));
    expect(row.detail).toMatchObject({ userId: c.other.id });
  });

  it('改套餐配额留痕，含改前配额', async () => {
    await c.service.updatePlan('pro', {
      name: 'Pro', priceMonth: 1000, priceYear: 10000,
      perUserMaxPrivateConnections: 999, perUserMaxOpenConnections: 0,
      perUserPrivateSyncQuotaBytes: 123, perUserSyncVersionRetention: 7, features: 0,
      includedSeats: 1, perSeatMaxDevices: 5, perUserHistoryRetentionCount: 0,
      orgMaxSharedConnections: 0, orgSharedSyncQuotaBytes: 0, orgMaxMembers: 0,
    }, actor(c.admin.id));

    const [row] = c.auditRepo.rows;
    expect(row.action).toBe('plan.update');
    expect(row.targetType).toBe('plan');
    expect(row.targetId).toBe('pro');
    expect((row.detail as any).perUserMaxPrivateConnections).toEqual({ from: 50, to: 999 });
  });

  it('detail 里不出现口令或 token 字样', async () => {
    const s = await c.rtRepo.create({
      userId: c.other.id, tokenHash: 'super-secret-hash', expiresTime: new Date(Date.now() + 86400_000),
    });
    await c.service.revokeSession(c.other.id, s.id, actor(c.admin.id));
    await c.service.updateUser(c.other.id, { role: 'admin' }, actor(c.admin.id));

    const dumped = JSON.stringify(c.auditRepo.rows);
    expect(dumped).not.toContain('super-secret-hash');
    expect(dumped.toLowerCase()).not.toContain('passwordhash');
  });

  it('recordAudit 供不经 AdminService 的管理操作留痕（续费 / 限流）', async () => {
    await c.service.recordAudit(actor(c.admin.id), 'organization.renew', 'organization', String(c.other.id), {
      planCode: 'pro', period: 'month',
    });
    const [row] = c.auditRepo.rows;
    expect(row.action).toBe('organization.renew');
    expect(row.detail).toMatchObject({ planCode: 'pro', period: 'month' });
  });
});