import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  FakeUserRepo,
  FakeOrganizationRepo,
  FakeOrganizationPlanRepo,
  FakeOrganizationSubscriptionRepo,
  FakeMembershipRepo,
  FakeInvitationRepo,
  FakeRateLimitRepo,
} from '../helpers/fakeRepos.js';
import { OrganizationService } from '../../src/service/organizationService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { TokenService } from '../../src/service/tokenService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import {
  ForbiddenError,
  InvitationInvalidError,
  InvitationTargetNotEligibleError,
  OrganizationQuotaExceededError,
  EntityNotFoundError,
  OrganizationNotFoundError,
} from '../../src/domain/errors.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

function makeTokenService(): TokenService {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return new TokenService({ kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) }, '15m', 30 * 24 * 3600 * 1000);
}

function makeService() {
  const organizationRepo = new FakeOrganizationRepo();
  const organizationPlanRepo = new FakeOrganizationPlanRepo();
  const organizationSubscriptionRepo = new FakeOrganizationSubscriptionRepo();
  const userRepo = new FakeUserRepo();
  const membershipRepo = new FakeMembershipRepo(userRepo, organizationRepo);
  const invitationRepo = new FakeInvitationRepo(membershipRepo);
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), false);
  const emailSender = new MemoryEmailSender();
  const svc = new OrganizationService(
    userRepo,
    organizationRepo,
    organizationPlanRepo,
    organizationSubscriptionRepo,
    membershipRepo,
    invitationRepo,
    rateLimiter,
    makeTokenService(),
    emailSender,
    async (fn) => fn({} as Queryable),
  );
  return { svc, organizationRepo, organizationSubscriptionRepo, membershipRepo, invitationRepo, userRepo, emailSender };
}

async function makeVerifiedUser(userRepo: FakeUserRepo, email: string, displayName?: string) {
  const user = await userRepo.create(email, 'hash', displayName);
  await userRepo.markEmailVerified({} as Queryable, user.id, new Date());
  return user;
}

describe('invitations (OrganizationService)', () => {
  it('inviteMember creates invited membership + pending invitation + email', async () => {
    const { svc, invitationRepo, userRepo, emailSender } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com', 'Bee');

    const r = await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    expect(r.role).toBe('member');

    const members = await svc.listMembers(org.organizationId);
    const inv = members.find((m) => m.userId === b.id);
    expect(inv?.status).toBe('invited');
    expect(inv?.role).toBe('member');

    expect([...invitationRepo.store.values()]).toHaveLength(1);
    const sent = emailSender.sent.find((m) => m.kind === 'invitation');
    expect(sent?.to).toBe('b@x.com');
    expect(sent?.token).toBeTruthy();
    expect(sent?.organizationName).toBe('Acme');
  });

  it('a plain member cannot invite (permission re-checked inside the transaction)', async () => {
    const { svc, userRepo, membershipRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    await makeVerifiedUser(userRepo, 'b@x.com');
    const plain = await makeVerifiedUser(userRepo, 'member@x.com');
    await membershipRepo.create({} as Queryable, {
      organizationId: org.organizationId,
      userId: plain.id,
      role: 'member',
      status: 'active',
      invitedByUserId: 1,
      joinedTime: new Date(),
      removedTime: null,
    });
    await expect(svc.inviteMember(org.organizationId, plain.id, 'b@x.com')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('an actor removed after middleware authorization can no longer invite', async () => {
    const { svc, userRepo, membershipRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    await makeVerifiedUser(userRepo, 'b@x.com');
    const admin = (await svc.listMembers(org.organizationId))[0];
    await membershipRepo.remove({} as Queryable, admin.membershipId, new Date());
    await expect(svc.inviteMember(org.organizationId, 1, 'b@x.com')).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('rejects unregistered or unverified target', async () => {
    const { svc, userRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    await expect(svc.inviteMember(org.organizationId, 1, 'missing@x.com')).rejects.toBeInstanceOf(InvitationTargetNotEligibleError);

    await userRepo.create('unverified@x.com', 'hash'); // 未验证
    await expect(svc.inviteMember(org.organizationId, 1, 'unverified@x.com')).rejects.toBeInstanceOf(InvitationTargetNotEligibleError);
  });

  it('rejects inviting an already-active member', async () => {
    const { svc, userRepo, emailSender } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com');
    await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    const token = emailSender.sent.find((m) => m.kind === 'invitation')!.token!;
    await svc.acceptInvitation(token, b.id);
    await expect(svc.inviteMember(org.organizationId, 1, 'b@x.com')).rejects.toBeInstanceOf(InvitationTargetNotEligibleError);
  });

  it('enforces seat capacity', async () => {
    const { svc, userRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme'); // seat 3，admin 占 1
    await makeVerifiedUser(userRepo, 'b@x.com');
    await makeVerifiedUser(userRepo, 'c@x.com');
    await makeVerifiedUser(userRepo, 'd@x.com');

    await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    await svc.inviteMember(org.organizationId, 1, 'c@x.com');
    await expect(svc.inviteMember(org.organizationId, 1, 'd@x.com')).rejects.toBeInstanceOf(OrganizationQuotaExceededError);
  });

  it('re-inviting the same target leaves exactly one valid token', async () => {
    const { svc, userRepo, invitationRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    await makeVerifiedUser(userRepo, 'b@x.com');

    await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    await svc.inviteMember(org.organizationId, 1, 'b@x.com');

    const pending = [...invitationRepo.store.values()].filter((i) => !i.acceptedTime && !i.revokedTime);
    expect(pending).toHaveLength(1);
    expect([...invitationRepo.store.values()]).toHaveLength(2);
  });

  it('acceptInvitation activates membership and marks invitation accepted', async () => {
    const { svc, userRepo, emailSender } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com');
    await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    const token = emailSender.sent.find((m) => m.kind === 'invitation')!.token!;

    const result = await svc.acceptInvitation(token, b.id);
    expect(result.organization.organizationId).toBe(org.organizationId);
    expect(result.organization.role).toBe('member');

    const members = await svc.listMembers(org.organizationId);
    const bMembership = members.find((m) => m.userId === b.id);
    expect(bMembership?.status).toBe('active');
    expect(bMembership?.joinedTime).toBeTruthy();
  });

  it('acceptInvitation rejects wrong token / email mismatch', async () => {
    const { svc, userRepo, emailSender } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com');
    const c = await makeVerifiedUser(userRepo, 'c@x.com');
    await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    const token = emailSender.sent.find((m) => m.kind === 'invitation')!.token!;

    await expect(svc.acceptInvitation('bad-token', b.id)).rejects.toBeInstanceOf(InvitationInvalidError);
    await expect(svc.acceptInvitation(token, c.id)).rejects.toBeInstanceOf(InvitationInvalidError);
  });

  it('acceptInvitation rejects consumed token', async () => {
    const { svc, userRepo, emailSender } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com');
    await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    const token = emailSender.sent.find((m) => m.kind === 'invitation')!.token!;
    await svc.acceptInvitation(token, b.id);
    await expect(svc.acceptInvitation(token, b.id)).rejects.toBeInstanceOf(InvitationInvalidError);
  });

  it('revokeInvitation releases capacity and removes membership', async () => {
    const { svc, userRepo, invitationRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com');
    const r = await svc.inviteMember(org.organizationId, 1, 'b@x.com');

    await svc.revokeInvitation(org.organizationId, 1, r.invitationId);
    expect(invitationRepo.store.get(r.invitationId)?.revokedTime).toBeTruthy();
    const members = await svc.listMembers(org.organizationId);
    expect(members.find((m) => m.userId === b.id)).toBeUndefined();
  });

  it('closeOrganization revokes pending invitations', async () => {
    const { svc, userRepo, invitationRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com');
    const r = await svc.inviteMember(org.organizationId, 1, 'b@x.com');

    await svc.closeOrganization(org.organizationId, 1);
    expect(invitationRepo.store.get(r.invitationId)?.revokedTime).toBeTruthy();
    const members = await svc.listMembers(org.organizationId);
    expect(members.find((m) => m.userId === b.id)).toBeUndefined();
  });

  it('acceptInvitation rejects expired/canceled subscription', async () => {
    const { svc, userRepo, emailSender, organizationSubscriptionRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com');
    await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    const token = emailSender.sent.find((m) => m.kind === 'invitation')!.token!;

    const sub = await organizationSubscriptionRepo.findByOrganizationId(org.organizationId);
    sub!.status = 'expired';
    await expect(svc.acceptInvitation(token, b.id)).rejects.toBeInstanceOf(InvitationInvalidError);
  });

  it('acceptInvitation rejects missing subscription', async () => {
    const { svc, userRepo, emailSender, organizationSubscriptionRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com');
    await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    const token = emailSender.sent.find((m) => m.kind === 'invitation')!.token!;

    organizationSubscriptionRepo.store.clear();
    await expect(svc.acceptInvitation(token, b.id)).rejects.toBeInstanceOf(InvitationInvalidError);
  });

  it('revokeInvitation cross-organization id returns NOT_FOUND', async () => {
    const { svc, userRepo } = makeService();
    const orgA = await svc.createOrganization(1, 'A');
    const orgB = await svc.createOrganization(2, 'B');
    await makeVerifiedUser(userRepo, 'b@x.com');
    const r = await svc.inviteMember(orgA.organizationId, 1, 'b@x.com');

    await expect(svc.revokeInvitation(orgB.organizationId, 1, r.invitationId)).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('revokeInvitation of an accepted invitation returns INVITATION_INVALID', async () => {
    const { svc, userRepo, emailSender } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    const b = await makeVerifiedUser(userRepo, 'b@x.com');
    const r = await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    const token = emailSender.sent.find((m) => m.kind === 'invitation')!.token!;
    await svc.acceptInvitation(token, b.id);

    await expect(svc.revokeInvitation(org.organizationId, 1, r.invitationId)).rejects.toBeInstanceOf(InvitationInvalidError);
  });
});
describe('expireInvitations must not touch active members', () => {
  it('leaves an already-active membership alone when a stale invitation still points at it', async () => {
    // 回归防线：expireByOrganization 的 UPDATE ... JOIN 必须带 AND m.status='invited'。
    // 少了它，后台清理会把邀请指向的成员行无条件置为 removed —— 即使那人已经 active。
    // 若那人是最后一个 admin，组织将落到零 admin 且不可恢复。
    const { svc, membershipRepo, invitationRepo, userRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    await makeVerifiedUser(userRepo, 'b@x.com');

    await svc.inviteMember(org.organizationId, 1, 'b@x.com');
    const inv = [...invitationRepo.store.values()][0];

    // 人为造出「成员已 active，但邀请行仍是未接受/未撤销且已过期」这个状态。
    const membership = membershipRepo.store.get(inv.membershipId)!;
    membership.status = 'active';
    membership.joinedTime = new Date();
    inv.expiresTime = new Date(Date.now() - 1000);

    await svc.expireInvitations();

    // 邀请被撤销是对的；成员必须保持 active。
    expect(membershipRepo.store.get(inv.membershipId)!.status).toBe('active');
    expect([...invitationRepo.store.values()][0].revokedTime).not.toBeNull();
  });

  it('still removes the membership when the invitation expires while genuinely invited', async () => {
    const { svc, membershipRepo, invitationRepo, userRepo } = makeService();
    const org = await svc.createOrganization(1, 'Acme');
    await makeVerifiedUser(userRepo, 'c@x.com');

    await svc.inviteMember(org.organizationId, 1, 'c@x.com');
    const inv = [...invitationRepo.store.values()][0];
    inv.expiresTime = new Date(Date.now() - 1000);

    await svc.expireInvitations();

    expect(membershipRepo.store.get(inv.membershipId)!.status).toBe('removed');
  });
});
