import { describe, expect, it, beforeEach } from 'vitest';
import { AdminService } from '../../src/service/adminService.js';
import {
  FakeAdminAuditRepo,
  FakeConnectionMetaRepo,
  FakeDeviceRepo,
  FakePlanRepo,
  FakeRefreshTokenRepo,
  FakeSubscriptionRepo,
  FakeSyncEventRepo,
  FakeSyncRepo,
  FakeUsageEventRepo,
  FakeUserRepo,
  makePlan,
} from '../helpers/fakeRepos.js';
import { ValidationError } from '../../src/domain/errors.js';

/**
 * 管理端的两类硬性约束：**不可自伤** 与 **留痕**。
 *
 * 这两件事都不是「锦上添花的校验」：
 *  - 自伤不可逆。admin 把自己降成 user 之后，恢复它需要的正是 admin 权限 ——
 *    唯一出路是直接连数据库改 `users.role`。生产库上手改行是最不该出现的
 *    运维动作，而触发它只需要在下拉框里点错一次。
 *  - 无痕的提权是审计黑洞。谁在什么时候把哪个账号提成了 admin、把谁的配额
 *    调大了、放行了哪个 IP —— 如果这些只体现为「当前状态」而没有历史，
 *    事后无法回答「这是谁干的」，出了事只能靠猜。
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
  // 配额给真实数量级：makePlan 默认全 0，而 0 在 PlanPolicy 里表示「无限」，
  // 用默认值搭出来的套餐会让「改前配额是多少」这类断言退化成 0 → N
  const planRepo = new FakePlanRepo([
    makePlan('free', { maxConnections: 5 }),
    makePlan('pro', { maxConnections: 50 }),
    makePlan('team', { maxConnections: 500 }),
  ]);
  const subRepo = new FakeSubscriptionRepo();
  const rtRepo = new FakeRefreshTokenRepo();
  const syncRepo = new FakeSyncRepo();
  const deviceRepo = new FakeDeviceRepo();
  const connectionMetaRepo = new FakeConnectionMetaRepo();
  const syncEventRepo = new FakeSyncEventRepo();
  const usageEventRepo = new FakeUsageEventRepo();
  const auditRepo = new FakeAdminAuditRepo();
  const service = new AdminService(
    userRepo, planRepo, subRepo, rtRepo, syncRepo,
    deviceRepo, connectionMetaRepo, syncEventRepo, usageEventRepo, auditRepo,
  );
  const admin = await userRepo.create('admin@example.com', 'scrypt$x$y', 'admin', 'free');
  const other = await userRepo.create('user@example.com', 'scrypt$x$y', 'user', 'free');
  return { service, userRepo, planRepo, auditRepo, rtRepo, admin, other };
}

/** 操作者上下文。ip 只用于留痕，不参与判定。 */
const actor = (id: number) => ({ userId: id, ip: '10.0.0.1' });

let c: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { c = await setup(); });

describe('AdminService.updateUser 自伤防护', () => {
  it('拒绝把自己降级为普通用户', async () => {
    // 先造第二个 admin，排除「最后一个 admin」这条规则的干扰 ——
    // 自我降级本身就该拦，与还剩几个 admin 无关。
    await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin', 'free');

    await expect(c.service.updateUser(c.admin.id, { role: 'user' }, actor(c.admin.id)))
      .rejects.toBeInstanceOf(ValidationError);
    expect((await c.userRepo.findById(c.admin.id))!.role).toBe('admin');
  });

  it('拒绝把自己禁用', async () => {
    await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin', 'free');

    await expect(c.service.updateUser(c.admin.id, { status: 'disabled' }, actor(c.admin.id)))
      .rejects.toBeInstanceOf(ValidationError);
    expect((await c.userRepo.findById(c.admin.id))!.status).toBe('active');
  });

  it('允许改自己的套餐（没有安全含义，且是常用的自助操作）', async () => {
    await c.service.updateUser(c.admin.id, { planCode: 'pro' }, actor(c.admin.id));
    expect((await c.userRepo.findById(c.admin.id))!.planCode).toBe('pro');
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
    // 用一个「本身不是 admin 但拿着 admin 上下文」的操作者不现实，
    // 这里让第二个 admin 先被合法降级，再尝试降最后一个。
    const a2 = await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin', 'free');
    await c.service.updateUser(a2.id, { role: 'user' }, actor(c.admin.id));
    expect(await c.userRepo.countAdmins()).toBe(1);

    // 现在 c.admin 是最后一个 admin，换个身份来降它
    await expect(c.service.updateUser(c.admin.id, { role: 'user' }, actor(a2.id)))
      .rejects.toThrow(/last admin|最后/i);
    expect((await c.userRepo.findById(c.admin.id))!.role).toBe('admin');
  });

  it('拒绝禁用仅存的 admin', async () => {
    const a2 = await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin', 'free');
    await c.service.updateUser(a2.id, { role: 'user' }, actor(c.admin.id));

    await expect(c.service.updateUser(c.admin.id, { status: 'disabled' }, actor(a2.id)))
      .rejects.toThrow(/last admin|最后/i);
    expect((await c.userRepo.findById(c.admin.id))!.status).toBe('active');
  });

  it('还剩两个 admin 时可以降级其中一个', async () => {
    const a2 = await c.userRepo.create('admin2@example.com', 'scrypt$x$y', 'admin', 'free');
    await c.service.updateUser(a2.id, { role: 'user' }, actor(c.admin.id));
    expect((await c.userRepo.findById(a2.id))!.role).toBe('user');
  });

  it('禁用一个非 admin 用户不受该规则影响', async () => {
    await c.service.updateUser(c.other.id, { status: 'disabled' }, actor(c.admin.id));
    expect((await c.userRepo.findById(c.other.id))!.status).toBe('disabled');
  });
});

describe('管理操作留痕', () => {
  it('改 role / plan / status 各留一条记录，含旧值与新值', async () => {
    await c.service.updateUser(c.other.id, { role: 'admin', planCode: 'pro', status: 'disabled' }, actor(c.admin.id));

    const rows = c.auditRepo.rows.filter((r) => r.action === 'user.update');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.actorUserId).toBe(c.admin.id);
    expect(row.targetType).toBe('user');
    expect(row.targetId).toBe(String(c.other.id));
    expect(row.ip).toBe('10.0.0.1');
    // 旧值是排查的关键：只记新值的话「配额从多少改成多少」永远查不到
    expect(row.detail).toMatchObject({
      role: { from: 'user', to: 'admin' },
      planCode: { from: 'free', to: 'pro' },
      status: { from: 'active', to: 'disabled' },
    });
  });

  it('只记实际改动的字段，没传的字段不出现在 detail 里', async () => {
    await c.service.updateUser(c.other.id, { planCode: 'team' }, actor(c.admin.id));
    const [row] = c.auditRepo.rows;
    expect(Object.keys(row.detail)).toEqual(['planCode']);
  });

  it('被拒绝的操作不留痕（没发生的事不该出现在审计里）', async () => {
    await expect(c.service.updateUser(c.other.id, { role: 'root' as any }, actor(c.admin.id)))
      .rejects.toBeInstanceOf(ValidationError);
    expect(c.auditRepo.rows).toHaveLength(0);
  });

  /**
   * 审计写入失败必须让操作失败。
   *
   * 反过来（吞掉审计错误、照常执行）等于「审计表一坏，所有管理操作就变成
   * 无痕操作」，而且没有任何迹象 —— 这正是攻击者拿到 admin 后最希望的状态。
   * 宁可拒绝服务：留痕写不进去时管理端短暂不可用是可感知、可修的，
   * 静默失去审计能力不是。
   */
  it('审计写入失败时拒绝执行操作', async () => {
    c.auditRepo.failNext = true;
    await expect(c.service.updateUser(c.other.id, { planCode: 'pro' }, actor(c.admin.id)))
      .rejects.toThrow(/audit/i);
    // 操作没有生效
    expect((await c.userRepo.findById(c.other.id))!.planCode).toBe('free');
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
      maxConnections: 999, syncQuotaBytes: 123, syncVersionRetention: 7, features: 0,
    }, actor(c.admin.id));

    const [row] = c.auditRepo.rows;
    expect(row.action).toBe('plan.update');
    expect(row.targetType).toBe('plan');
    expect(row.targetId).toBe('pro');
    expect((row.detail as any).maxConnections).toEqual({ from: 50, to: 999 });
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
    await c.service.recordAudit(actor(c.admin.id), 'user.renew', 'user', String(c.other.id), {
      planCode: 'pro', period: 'month',
    });
    const [row] = c.auditRepo.rows;
    expect(row.action).toBe('user.renew');
    expect(row.detail).toMatchObject({ planCode: 'pro', period: 'month' });
  });
});
