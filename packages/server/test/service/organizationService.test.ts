import { describe, it, expect } from 'vitest';
import { OrganizationService } from '../../src/service/organizationService.js';
import { resolveEffectivePlans } from '../../src/policy/planPolicy.js';
import {
  FakeOrganizationRepo, FakeMembershipRepo, FakeSeatRepo,
  FakeOrganizationResourceRepo, FakeOrganizationAuditRepo,
  FakeSubscriptionRepo, FakePlanRepo, makePlan,
} from '../helpers/fakeRepos.js';

async function setup() {
  const orgRepo = new FakeOrganizationRepo();
  const membershipRepo = new FakeMembershipRepo();
  const seatRepo = new FakeSeatRepo();
  const resourceRepo = new FakeOrganizationResourceRepo();
  const auditRepo = new FakeOrganizationAuditRepo();
  const subRepo = new FakeSubscriptionRepo();
  const planRepo = new FakePlanRepo([makePlan('free'), makePlan('pro'), makePlan('team', { includedSeats: 5 })]);
  const service = new OrganizationService(orgRepo, membershipRepo, seatRepo, resourceRepo, auditRepo, subRepo, planRepo);
  const org = await orgRepo.create({ name: 'Acme', type: 'team', ownerUserId: 1 });
  await membershipRepo.create({ organizationId: org.id, userId: 1, role: 'admin' });
  const member = await membershipRepo.create({ organizationId: org.id, userId: 2, role: 'member' });
  return { service, orgRepo, membershipRepo, seatRepo, resourceRepo, subRepo, planRepo, org, memberId: member.id };
}

async function setupForCreate() {
  const orgRepo = new FakeOrganizationRepo();
  const membershipRepo = new FakeMembershipRepo();
  const seatRepo = new FakeSeatRepo();
  const resourceRepo = new FakeOrganizationResourceRepo();
  const auditRepo = new FakeOrganizationAuditRepo();
  const subRepo = new FakeSubscriptionRepo();
  const planRepo = new FakePlanRepo([makePlan('free'), makePlan('pro'), makePlan('team', { includedSeats: 5 })]);
  const service = new OrganizationService(orgRepo, membershipRepo, seatRepo, resourceRepo, auditRepo, subRepo, planRepo);
  return { service, orgRepo, membershipRepo, seatRepo, subRepo, planRepo };
}

describe('OrganizationService.createOrganization 席位补齐', () => {
  it('建 team 组织即补 team 订阅（trialing 14 天试用）+ included_seats 个席位', async () => {
    const c = await setupForCreate();
    const before = Date.now();
    const { organization, membership } = await c.service.createOrganization(1, 'Acme');

    expect(organization.type).toBe('team');
    expect(membership.role).toBe('admin');
    const sub = await c.subRepo.findByOrganizationId(organization.id);
    expect(sub).toBeDefined();
    // 不得建 active 订阅——那等于免费永久发放付费套餐（付费门禁旁路）
    expect(sub!.status).toBe('trialing');
    const teamPlan = await c.planRepo.findByCode('team');
    expect(sub!.planId).toBe(teamPlan!.id);
    expect(sub!.trialEndTime).toBeInstanceOf(Date);
    // trialEndTime ≈ now + 14d
    const trialMs = sub!.trialEndTime!.getTime() - before;
    expect(trialMs).toBeGreaterThan(13 * 86_400_000);
    expect(trialMs).toBeLessThan(15 * 86_400_000);
    expect(sub!.periodEndTime).toBeUndefined();
    // owner 占 1 席，剩余 4 席可加成员
    expect(await c.seatRepo.countActiveByOrganization(organization.id)).toBe(5);
  });

  it('建组织后 addMember 不再恒抛 no available seat', async () => {
    const c = await setupForCreate();
    const { organization } = await c.service.createOrganization(1, 'Acme');
    const m = await c.service.addMember(organization.id, 2, 'member', 1);
    expect(m.role).toBe('member');
    expect(await c.seatRepo.countActiveByOrganization(organization.id)).toBe(5);
  });
});

describe('OrganizationService.listResources restricted 授权', () => {
  it('admin 可见全部资源（含 restricted）', async () => {
    const c = await setup();
    await c.resourceRepo.create({
      organizationId: c.org.id, resourceType: 'query', name: 'org-res',
      accessScope: 'organization', encryptedData: 'enc-org', createdByUserId: 1,
    });
    await c.resourceRepo.create({
      organizationId: c.org.id, resourceType: 'query', name: 'restricted-res',
      accessScope: 'restricted', encryptedData: 'enc-restricted', createdByUserId: 1,
    });

    const list = await c.service.listResources(c.org.id, 1);

    expect(list).toHaveLength(2);
    expect(list.map((r) => r.name).sort()).toEqual(['org-res', 'restricted-res']);
  });

  it('member 看不到未被授权的 restricted 资源（密文不泄漏）', async () => {
    const c = await setup();
    await c.resourceRepo.create({
      organizationId: c.org.id, resourceType: 'query', name: 'org-res',
      accessScope: 'organization', encryptedData: 'enc-org', createdByUserId: 1,
    });
    await c.resourceRepo.create({
      organizationId: c.org.id, resourceType: 'query', name: 'restricted-res',
      accessScope: 'restricted', encryptedData: 'enc-restricted', createdByUserId: 1,
    });

    const list = await c.service.listResources(c.org.id, 2);

    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('org-res');
    expect(list.find((r) => r.accessScope === 'restricted')).toBeUndefined();
  });

  it('member 被显式授权后可见对应 restricted 资源', async () => {
    const c = await setup();
    const restricted = await c.resourceRepo.create({
      organizationId: c.org.id, resourceType: 'query', name: 'restricted-res',
      accessScope: 'restricted', encryptedData: 'enc-restricted', createdByUserId: 1,
    });
    await c.resourceRepo.grantPermission(c.org.id, restricted.id, c.memberId, 'read');

    const list = await c.service.listResources(c.org.id, 2);

    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('restricted-res');
    expect(list[0].encryptedData).toBe('enc-restricted');
  });

  it('type 过滤仍生效且不绕过 restricted 授权', async () => {
    const c = await setup();
    await c.resourceRepo.create({
      organizationId: c.org.id, resourceType: 'query', name: 'q-org',
      accessScope: 'organization', encryptedData: 'enc', createdByUserId: 1,
    });
    await c.resourceRepo.create({
      organizationId: c.org.id, resourceType: 'folder', name: 'f-org',
      accessScope: 'organization', encryptedData: 'enc', createdByUserId: 1,
    });
    const restricted = await c.resourceRepo.create({
      organizationId: c.org.id, resourceType: 'query', name: 'q-restricted',
      accessScope: 'restricted', encryptedData: 'enc', createdByUserId: 1,
    });

    // 未授权 member 按 query 过滤：只看到 org 的 query，看不到 restricted query
    const list = await c.service.listResources(c.org.id, 2, 'query');
    expect(list.map((r) => r.name)).toEqual(['q-org']);

    // 授权后可见
    await c.resourceRepo.grantPermission(c.org.id, restricted.id, c.memberId, 'read');
    const list2 = await c.service.listResources(c.org.id, 2, 'query');
    expect(list2.map((r) => r.name).sort()).toEqual(['q-org', 'q-restricted']);
  });
});

describe('team 试用到期降级（付费门禁旁路 #2 修复）', () => {
  it('试用期内 resolveEffectivePlans 解出 team 套餐', async () => {
    const c = await setupForCreate();
    const { organization } = await c.service.createOrganization(1, 'Acme');
    expect(organization).toBeDefined();
    const plans = await resolveEffectivePlans(1, { membershipRepo: c.membershipRepo, subRepo: c.subRepo, planRepo: c.planRepo });
    expect(plans.map((p) => p.code)).toContain('team');
  });

  it('试用到期后 resolveEffectivePlans 不再解出 team（回落 free）', async () => {
    const c = await setupForCreate();
    const { organization } = await c.service.createOrganization(1, 'Acme');
    const sub = (await c.subRepo.findByOrganizationId(organization.id))!;
    await c.subRepo.upsert({ id: sub.id, organizationId: organization.id, planId: sub.planId, status: 'trialing', provider: 'manual', trialEndTime: new Date(Date.now() - 1000) });
    const plans = await resolveEffectivePlans(1, { membershipRepo: c.membershipRepo, subRepo: c.subRepo, planRepo: c.planRepo });
    expect(plans.map((p) => p.code)).not.toContain('team');
    expect(plans.map((p) => p.code)).toContain('free');
  });

  it('expireOne 把 trialing 试用到期降为 expired', async () => {
    const c = await setupForCreate();
    const { organization } = await c.service.createOrganization(1, 'Acme');
    const sub = (await c.subRepo.findByOrganizationId(organization.id))!;
    await c.subRepo.upsert({ id: sub.id, organizationId: organization.id, planId: sub.planId, status: 'trialing', provider: 'manual', trialEndTime: new Date(Date.now() - 1000) });
    const changed = await c.subRepo.expireOne(organization.id, new Date());
    expect(changed).toBe(true);
    const after = (await c.subRepo.findByOrganizationId(organization.id))!;
    expect(after.status).toBe('expired');
  });

  it('downgradeExpired 批量降级 trialing 试用到期', async () => {
    const c = await setupForCreate();
    const { organization } = await c.service.createOrganization(1, 'Acme');
    const sub = (await c.subRepo.findByOrganizationId(organization.id))!;
    await c.subRepo.upsert({ id: sub.id, organizationId: organization.id, planId: sub.planId, status: 'trialing', provider: 'manual', trialEndTime: new Date(Date.now() - 1000) });
    const n = await c.subRepo.downgradeExpired(new Date());
    expect(n).toBeGreaterThanOrEqual(1);
    const after = (await c.subRepo.findByOrganizationId(organization.id))!;
    expect(after.status).toBe('expired');
  });
});
