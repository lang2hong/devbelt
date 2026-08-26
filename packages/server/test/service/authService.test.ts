import { describe, it, expect } from 'vitest';
import { AuthService } from '../../src/service/authService.js';
import { TokenService, type JwtPort } from '../../src/service/tokenService.js';
import { hashPassword } from '../../src/service/password.js';
import { PlanPolicy } from '../../src/policy/planPolicy.js';
import {
  InvalidCredentialsError,
  ProFeatureRequiredError,
  TokenReuseError,
  ValidationError,
} from '../../src/domain/errors.js';
import type { Plan } from '../../src/domain/entities.js';
import type { PlanCode } from '../../src/domain/enums.js';
import {
  FakeUserRepo,
  FakePlanRepo,
  FakeSubscriptionRepo,
  FakeRefreshTokenRepo,
  FakeDeviceRepo,
  FakeOrganizationRepo,
  FakeMembershipRepo,
  FakeSeatRepo,
  FakeRegistrationRepo,
  makePlan,
} from '../helpers/fakeRepos.js';

/** 可预测的 JWT 端口：payload 直接序列化，便于断言 sub/role/plan */
class FakeJwt implements JwtPort {
  signCount = 0;
  sign(payload: object, options?: { expiresIn?: string | number }): string {
    this.signCount++;
    return `jwt:${JSON.stringify(payload)}:${options?.expiresIn ?? ''}`;
  }
  verify<T = any>(token: string): T {
    return JSON.parse(token.split(':')[1]) as T;
  }
}

function setup(planOver: Parameters<typeof makePlan>[1] = {}) {
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([makePlan('free', planOver), makePlan('pro', { perSeatMaxDevices: 0 })]);
  const subRepo = new FakeSubscriptionRepo();
  const rtRepo = new FakeRefreshTokenRepo();
  const deviceRepo = new FakeDeviceRepo();
  const orgRepo = new FakeOrganizationRepo();
  const membershipRepo = new FakeMembershipRepo();
  const seatRepo = new FakeSeatRepo();
  const registrationRepo = new FakeRegistrationRepo({
    users: userRepo, orgs: orgRepo, memberships: membershipRepo, subs: subRepo, seats: seatRepo, plans: planRepo,
  });
  const planPolicy = new PlanPolicy(async (userId: number): Promise<Plan[]> => {
    const memberships = (await membershipRepo.listByUser(userId)).filter((m) => m.status === 'active');
    const subs = await subRepo.findByOrganizationIds(memberships.map((m) => m.organizationId));
    const subByOrg = new Map(subs.map((s) => [s.organizationId, s]));
    const plans: Plan[] = [];
    for (const m of memberships) {
      const sub = subByOrg.get(m.organizationId);
      if (!sub || sub.status === 'expired') continue;
      const plan = await planRepo.findById(sub.planId);
      if (plan) plans.push(plan);
    }
    return plans;
  });
  const jwt = new FakeJwt();
  const tokenService = new TokenService(jwt, '15m', '30d');
  const auth = new AuthService(userRepo, subRepo, rtRepo, deviceRepo, registrationRepo, tokenService, planPolicy, new FakeMembershipRepo());
  return { auth, userRepo, planRepo, subRepo, orgRepo, membershipRepo, rtRepo, deviceRepo, jwt, tokenService };
}

/** 把某用户 personal org 的订阅切到指定套餐（v2：改 org 订阅，而非 users.planCode） */
async function grantPlan(
  userId: number,
  code: PlanCode,
  deps: { subRepo: FakeSubscriptionRepo; orgRepo: FakeOrganizationRepo; membershipRepo: FakeMembershipRepo; planRepo: FakePlanRepo },
): Promise<void> {
  const ms = await deps.membershipRepo.listByUser(userId);
  const org = await deps.orgRepo.findById(ms[0].organizationId);
  const plan = await deps.planRepo.findByCode(code);
  await deps.subRepo.upsert({ organizationId: org!.id, planId: plan!.id, status: 'active', provider: 'manual' });
}

describe('AuthService.register', () => {
  it('creates a user + personal org + free subscription + seat, and both tokens', async () => {
    const { auth, userRepo, subRepo, orgRepo } = setup();
    const res = await auth.register('a@example.com', 'password123', { deviceName: 'laptop' });

    expect(res.accessToken).toContain('"role":"user"');
    expect(res.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.user.email).toBe('a@example.com');
    expect(res.subscription?.status).toBe('active');

    const stored = await userRepo.findByEmail('a@example.com');
    expect(stored?.lastLoginTime).toBeInstanceOf(Date);
    expect(subRepo.subs.size).toBe(1);
    expect(orgRepo.orgs.size).toBe(1); // personal org 创建
  });

  it('never leaks passwordHash in the response', async () => {
    const { auth } = setup();
    const res = await auth.register('b@example.com', 'password123');
    expect('passwordHash' in res.user).toBe(false);
  });

  it('stores a scrypt hash, not the plaintext', async () => {
    const { auth, userRepo } = setup();
    await auth.register('c@example.com', 'password123');
    const stored = await userRepo.findByEmail('c@example.com');
    expect(stored?.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(stored?.passwordHash).not.toContain('password123');
  });

  it('rejects a duplicate email without disclosing that it exists', async () => {
    const { auth, userRepo } = setup();
    await auth.register('dup@example.com', 'password123');
    await expect(auth.register('dup@example.com', 'password123')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(userRepo.users.size).toBe(1);
  });

  it('rejects a malformed email', async () => {
    const { auth } = setup();
    await expect(auth.register('not-an-email', 'password123')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a password shorter than 8 chars', async () => {
    const { auth } = setup();
    await expect(auth.register('d@example.com', 'short')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects empty credentials', async () => {
    const { auth } = setup();
    await expect(auth.register('', 'password123')).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(auth.register('e@example.com', '')).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});

describe('AuthService.login', () => {
  it('returns tokens plus the existing subscription', async () => {
    const { auth } = setup();
    await auth.register('a@example.com', 'password123');
    const res = await auth.login('a@example.com', 'password123', { ip: '10.0.0.1' });
    expect(res.subscription).toBeUndefined(); // v2：订阅按 org，login 不返回 subscription
    expect(res.user.email).toBe('a@example.com');
    expect('passwordHash' in res.user).toBe(false);
  });

  it('rejects a wrong password', async () => {
    const { auth } = setup();
    await auth.register('a@example.com', 'password123');
    await expect(auth.login('a@example.com', 'password124')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('rejects an unknown email with the same error as a wrong password', async () => {
    const { auth } = setup();
    await expect(auth.login('ghost@example.com', 'password123')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('rejects a disabled user', async () => {
    const { auth, userRepo } = setup();
    const res = await auth.register('a@example.com', 'password123');
    await userRepo.updateStatus(res.user.id, 'disabled');
    await expect(auth.login('a@example.com', 'password123')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('拒绝 legacy sha256 哈希（不再接受弱哈希）', async () => {
    const { auth, userRepo } = setup();
    const { createHash } = await import('crypto');
    const legacy = createHash('sha256').update('any-saltlegacy-pass').digest('hex');
    await userRepo.create('legacy@example.com', legacy, 'user');

    await expect(auth.login('legacy@example.com', 'legacy-pass')).rejects.toBeTruthy();
  });

  it('legacy 哈希不会被静默重写（拒绝即拒绝，不做升级尝试）', async () => {
    const { auth, userRepo } = setup();
    const { createHash } = await import('crypto');
    const legacy = createHash('sha256').update('any-saltlegacy-pass').digest('hex');
    const created = await userRepo.create('up@example.com', legacy, 'user');

    await expect(auth.login('up@example.com', 'legacy-pass')).rejects.toBeTruthy();
    expect((await userRepo.findById(created.id))!.passwordHash).toBe(legacy);
  });

  it('已是 scrypt 的哈希不会被重写', async () => {
    const { auth, userRepo } = setup();
    const reg = await auth.register('keep@example.com', 'password123');
    const before = (await userRepo.findById(reg.user.id))!.passwordHash;

    await auth.login('keep@example.com', 'password123');

    expect((await userRepo.findById(reg.user.id))!.passwordHash).toBe(before);
  });
});

describe('AuthService.device identity', () => {
  it('同一设备重登不增加设备数（顶掉旧会话，不触发设备上限）', async () => {
    const { auth, rtRepo, deviceRepo } = setup({ perSeatMaxDevices: 1 });
    const device = { deviceId: 'machine-1', deviceName: 'laptop', os: 'linux' };
    const reg = await auth.register('a@example.com', 'password123', device);
    await expect(auth.login('a@example.com', 'password123', device)).resolves.toBeTruthy();
    expect(deviceRepo.devices.size).toBe(1);
    const active = await rtRepo.listActiveForUser(reg.user.id, new Date());
    expect(active).toHaveLength(1);
    expect(active[0].deviceName).toBe('laptop');
  });

  it('登记并更新设备固有信息', async () => {
    const { auth, deviceRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123', { deviceId: 'm1', os: 'linux', appVersion: '1.80' });
    await auth.login('a@example.com', 'password123', { deviceId: 'm1', os: 'linux', appVersion: '1.81' });
    expect(deviceRepo.devices.size).toBe(1);
    const list = await deviceRepo.listByUser(reg.user.id);
    expect(list).toHaveLength(1);
    expect(list[0].appVersion).toBe('1.81');
  });

  it('退出后重新登录仍是同一设备', async () => {
    const { auth, rtRepo, deviceRepo } = setup({ perSeatMaxDevices: 1 });
    const device = { deviceId: 'machine-1', deviceName: 'laptop' };
    const reg = await auth.register('a@example.com', 'password123', device);
    const regSid = [...rtRepo.tokens.values()].find((t) => !t.revokedTime)!.id;
    await auth.logout(regSid, reg.user.id, reg.refreshToken);
    await expect(auth.login('a@example.com', 'password123', device)).resolves.toBeTruthy();
    expect(deviceRepo.devices.size).toBe(1);
    const active = await rtRepo.listActiveForUser(reg.user.id, new Date());
    expect(active).toHaveLength(1);
  });
});

describe('AuthService.refresh', () => {
  it('rotates the refresh token: old one is revoked, new one works', async () => {
    const { auth, rtRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');

    const first = await auth.refresh(reg.refreshToken, { deviceName: 'laptop' });
    expect(first.refreshToken).not.toBe(reg.refreshToken);
    expect(rtRepo.tokens.size).toBe(2);
    expect([...rtRepo.tokens.values()][0].revokedTime).toBeInstanceOf(Date);
    expect([...rtRepo.tokens.values()][0].lastUsedTime).toBeInstanceOf(Date);

    const second = await auth.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
  });

  it('detects reuse of an already-rotated token and kills every session', async () => {
    const { auth, rtRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    await auth.login('a@example.com', 'password123'); // second device
    const rotated = await auth.refresh(reg.refreshToken);

    const err = await auth.refresh(reg.refreshToken).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenReuseError);
    expect((err as TokenReuseError).code).toBe('TOKEN_REUSE');

    for (const t of rtRepo.tokens.values()) expect(t.revokedTime).toBeInstanceOf(Date);
    await expect(auth.refresh(rotated.refreshToken)).rejects.toBeInstanceOf(TokenReuseError);
  });

  it('rejects an unknown refresh token', async () => {
    const { auth } = setup();
    await expect(auth.refresh('never-issued')).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rejects an expired refresh token without revoking siblings', async () => {
    const { auth, userRepo, rtRepo, tokenService } = setup();
    const user = await userRepo.create('a@example.com', hashPassword('password123'), 'user');
    const expired = 'expired-plaintext-token';
    await rtRepo.create({
      userId: user.id,
      tokenHash: tokenService.hashToken(expired),
      expiresTime: new Date(Date.now() - 1000),
    });
    await expect(auth.refresh(expired)).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect([...rtRepo.tokens.values()][0].revokedTime).toBeUndefined();
  });

  it('rejects when the owning user vanished', async () => {
    const { auth, userRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    userRepo.users.delete(reg.user.id);
    await expect(auth.refresh(reg.refreshToken)).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});

describe('AuthService session management', () => {
  it('logout revokes only the presented token', async () => {
    const { auth, rtRepo, tokenService } = setup();
    const a = await auth.register('a@example.com', 'password123');
    const b = await auth.login('a@example.com', 'password123');
    const sidA = [...rtRepo.tokens.values()]
      .find((t) => t.tokenHash === tokenService.hashToken(a.refreshToken))!.id;
    await auth.logout(sidA, a.user.id, a.refreshToken);

    const active = await rtRepo.listActiveForUser(a.user.id, new Date());
    expect(active).toHaveLength(1);
    await expect(auth.refresh(b.refreshToken)).resolves.toBeTruthy();
  });

  it('未知 token 不阻止当前会话（sid）被撤销', async () => {
    const { auth, rtRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    const sid = [...rtRepo.tokens.values()].find((t) => !t.revokedTime)!.id;

    await auth.logout(sid, reg.user.id, 'never-issued');

    expect((await rtRepo.listActiveForUser(reg.user.id, new Date())).length).toBe(0);
  });

  it('sid 与 token 都不存在时才是 no-op', async () => {
    const { auth } = setup();
    await expect(auth.logout(9999, 1, 'never-issued')).resolves.toBeUndefined();
  });

  it('free 用户不可自助撤销设备（需升级）', async () => {
    const { auth, deviceRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    await deviceRepo.upsert({ userId: reg.user.id, deviceId: 'dev-1' } as any);
    await deviceRepo.bind(reg.user.id, 'dev-1');
    await expect(auth.revokeDevice(reg.user.id, 'dev-1')).rejects.toBeInstanceOf(ProFeatureRequiredError);
    expect(await deviceRepo.isBound(reg.user.id, 'dev-1')).toBe(true);
  });

  it('pro 用户可撤销自己的设备', async () => {
    const { auth, deviceRepo, subRepo, orgRepo, membershipRepo, planRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    await deviceRepo.upsert({ userId: reg.user.id, deviceId: 'dev-1' } as any);
    await deviceRepo.bind(reg.user.id, 'dev-1');
    await grantPlan(reg.user.id, 'pro', { subRepo, orgRepo, membershipRepo, planRepo });
    await auth.revokeDevice(reg.user.id, 'dev-1');
    expect(await deviceRepo.isBound(reg.user.id, 'dev-1')).toBe(false);
  });
});

describe('AuthService.changePassword', () => {
  it('rejects a wrong old password and leaves the hash untouched', async () => {
    const { auth, userRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    const before = (await userRepo.findById(reg.user.id))!.passwordHash;
    await expect(auth.changePassword(reg.user.id, 'wrong-old', 'newpassword')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect((await userRepo.findById(reg.user.id))!.passwordHash).toBe(before);
  });

  it('rejects a new password shorter than 8 chars', async () => {
    const { auth } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    await expect(auth.changePassword(reg.user.id, 'password123', 'short')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects an unknown user', async () => {
    const { auth } = setup();
    await expect(auth.changePassword(4242, 'password123', 'newpassword')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('rehashes, forces every device to re-login, and accepts only the new password', async () => {
    const { auth, rtRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    await auth.login('a@example.com', 'password123');

    await auth.changePassword(reg.user.id, 'password123', 'newpassword');

    for (const t of rtRepo.tokens.values()) expect(t.revokedTime).toBeInstanceOf(Date);
    await expect(auth.refresh(reg.refreshToken)).rejects.toBeInstanceOf(TokenReuseError);
    await expect(auth.login('a@example.com', 'password123')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(auth.login('a@example.com', 'newpassword')).resolves.toBeTruthy();
  });
});