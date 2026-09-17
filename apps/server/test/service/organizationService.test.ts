import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  FakeUserRepo,
  FakeOrganizationRepo,
  FakePlanRepo,
  FakeOrganizationSubscriptionRepo,
  FakeMembershipRepo,
  FakeInvitationRepo,
  FakeRateLimitRepo,
} from '../helpers/fakeRepos.js';
import { OrganizationService } from '../../src/service/organizationService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { TokenService } from '../../src/service/tokenService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import { OrganizationAdminRequiredError, ForbiddenError, EntityNotFoundError, ValidationError, OrganizationNotFoundError } from '../../src/domain/errors.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

function makeService() {
  const organizationRepo = new FakeOrganizationRepo();
  const planRepo = new FakePlanRepo();
  const organizationSubscriptionRepo = new FakeOrganizationSubscriptionRepo();
  const userRepo = new FakeUserRepo();
  const membershipRepo = new FakeMembershipRepo(userRepo, organizationRepo);
  const invitationRepo = new FakeInvitationRepo(membershipRepo);
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), false);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const tokenService = new TokenService({ kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) }, '15m', 30 * 24 * 3600 * 1000);
  const svc = new OrganizationService(
    userRepo,
    organizationRepo,
    planRepo,
    organizationSubscriptionRepo,
    membershipRepo,
    invitationRepo,
    rateLimiter,
    tokenService,
    new MemoryEmailSender(),
    async (fn) => fn({} as Queryable),
  );
  return { svc, organizationRepo, membershipRepo, organizationSubscriptionRepo };
}

/** 建一个组织，返回 { orgId, adminMembershipId, creatorId }。 */
async function createOrg(svc: OrganizationService, creatorId = 1) {
  const org = await svc.createOrganization(creatorId, 'Acme');
  return { orgId: org.organizationId, memberships: await svc.listMembers(org.organizationId) };
}

/** 往组织里加第二个 admin 成员，返回其 membership id。 */
async function addAdmin(membershipRepo: FakeMembershipRepo, orgId: number, userId: number) {
  return membershipRepo.create({} as Queryable, {
    organizationId: orgId,
    userId,
    role: 'admin',
    status: 'active',
    invitedByUserId: null,
    joinedTime: new Date(),
    removedTime: null,
  });
}

describe('OrganizationService', () => {
  it('createOrganization creates org + free subscription + first active admin', async () => {
    const { svc, membershipRepo, organizationSubscriptionRepo } = makeService();
    const org = await svc.createOrganization(1, '  Acme  ');
    expect(org.name).toBe('Acme');
    const sub = await organizationSubscriptionRepo.findByOrganizationId(org.organizationId);
    expect(sub?.seatLimit).toBe(3);
    const members = await membershipRepo.listByOrganization(org.organizationId);
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('admin');
    expect(members[0].status).toBe('active');
  });

  it('a non-member actor cannot assign roles (404, authorization re-checked in tx)', async () => {
    const { svc } = makeService();
    const { orgId, memberships } = await createOrg(svc, 1);
    await expect(svc.assignRole(orgId, memberships[0].membershipId, 'member', 2)).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('an actor demoted after middleware authorization can no longer assign roles', async () => {
    const { svc, membershipRepo } = makeService();
    const { orgId, memberships } = await createOrg(svc, 1);
    const second = await addAdmin(membershipRepo, orgId, 2);
    // 模拟「中间件放行后被并发降级」：actor 2 已不再是 admin
    await membershipRepo.updateRole({} as Queryable, second.id, 'member');
    await expect(svc.assignRole(orgId, memberships[0].membershipId, 'member', 2)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('an actor removed after middleware authorization can no longer remove members', async () => {
    const { svc, membershipRepo } = makeService();
    const { orgId, memberships } = await createOrg(svc, 1);
    const second = await addAdmin(membershipRepo, orgId, 2);
    await membershipRepo.remove({} as Queryable, second.id, new Date());
    await expect(svc.removeMember(orgId, memberships[0].membershipId, 2)).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('updateOrganization and closeOrganization reject a non-member actor', async () => {
    const { svc } = makeService();
    const { orgId } = await createOrg(svc, 1);
    await expect(svc.updateOrganization(orgId, 2, 'Renamed')).rejects.toBeInstanceOf(OrganizationNotFoundError);
    await expect(svc.closeOrganization(orgId, 2)).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('updateOrganization rejects an actor without organization.update', async () => {
    const { svc, membershipRepo } = makeService();
    const { orgId } = await createOrg(svc, 1);
    await membershipRepo.create({} as Queryable, {
      organizationId: orgId, userId: 3, role: 'member', status: 'active',
      invitedByUserId: 1, joinedTime: new Date(), removedTime: null,
    });
    await expect(svc.updateOrganization(orgId, 3, 'Renamed')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('cannot assign role to self', async () => {
    const { svc } = makeService();
    const { orgId, memberships } = await createOrg(svc, 1);
    await expect(svc.assignRole(orgId, memberships[0].membershipId, 'member', 1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('can demote an admin when another admin remains', async () => {
    const { svc, membershipRepo } = makeService();
    const { orgId } = await createOrg(svc, 1);
    const second = await addAdmin(membershipRepo, orgId, 2);
    await svc.assignRole(orgId, second.id, 'member', 1);
    const admins = (await svc.listMembers(orgId)).filter((m) => m.role === 'admin');
    expect(admins).toHaveLength(1);
  });

  it('a non-member actor cannot remove members (404)', async () => {
    const { svc } = makeService();
    const { orgId, memberships } = await createOrg(svc, 1);
    await expect(svc.removeMember(orgId, memberships[0].membershipId, 2)).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('cannot remove self', async () => {
    const { svc } = makeService();
    const { orgId, memberships } = await createOrg(svc, 1);
    await expect(svc.removeMember(orgId, memberships[0].membershipId, 1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('last admin cannot leave', async () => {
    const { svc } = makeService();
    const { orgId } = await createOrg(svc, 1);
    await expect(svc.leaveOrganization(orgId, 1)).rejects.toBeInstanceOf(OrganizationAdminRequiredError);
  });

  it('a member can leave', async () => {
    const { svc, membershipRepo } = makeService();
    const { orgId } = await createOrg(svc, 1);
    const second = await addAdmin(membershipRepo, orgId, 2);
    expect(second.id).toBeTruthy();
    await svc.leaveOrganization(orgId, 2);
    const members = await svc.listMembers(orgId);
    expect(members.filter((m) => m.role === 'admin')).toHaveLength(1);
  });

  it('assignRole with a cross-org membership id throws not-found', async () => {
    const { svc } = makeService();
    const { orgId } = await createOrg(svc, 1);
    await svc.createOrganization(2, 'Other');
    await expect(svc.assignRole(orgId, 999999, 'admin', 1)).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('listOrganizations returns only active orgs the user is an active member of', async () => {
    const { svc } = makeService();
    const a = await svc.createOrganization(1, 'A');
    await svc.createOrganization(2, 'B');
    const list = await svc.listOrganizations(1);
    expect(list.map((o) => o.name)).toEqual(['A']);
    expect(a.name).toBe('A');
  });

  it('rejects blank or over-long organization name with ValidationError', async () => {
    const { svc } = makeService();
    await expect(svc.createOrganization(1, '   ')).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.createOrganization(1, 'x'.repeat(101))).rejects.toBeInstanceOf(ValidationError);
  });

  it('closeOrganization revokes invited memberships and keeps active admin', async () => {
    const { svc, membershipRepo } = makeService();
    const { orgId } = await createOrg(svc, 1);
    const invited = await membershipRepo.create({} as Queryable, {
      organizationId: orgId,
      userId: 2,
      role: 'member',
      status: 'invited',
      invitedByUserId: 1,
      joinedTime: null,
      removedTime: null,
    });
    await svc.closeOrganization(orgId, 1);
    expect(membershipRepo.store.get(invited.id)?.status).toBe('removed');
    const all = await svc.listMembers(orgId);
    expect(all).toHaveLength(1);
    expect(all[0].role).toBe('admin');
    expect(all[0].status).toBe('active');
  });
});