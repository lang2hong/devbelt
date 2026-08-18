import { describe, it, expect } from 'vitest';
import { AuthService } from '../../src/service/authService.js';
import { TokenService, type JwtPort } from '../../src/service/tokenService.js';
import { hashPassword } from '../../src/service/password.js';
import {
  InvalidCredentialsError,
  TokenReuseError,
  ValidationError,
} from '../../src/domain/errors.js';
import {
  FakeUserRepo,
  FakePlanRepo,
  FakeSubscriptionRepo,
  FakeRefreshTokenRepo,
  FakeDeviceRepo,
  makePlan,
} from '../helpers/fakeRepos.js';

const JWT_SECRET = 'test-jwt-secret';

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
  const planRepo = new FakePlanRepo([makePlan('free', planOver), makePlan('pro', { maxDevices: 0 })]);
  const subRepo = new FakeSubscriptionRepo();
  const rtRepo = new FakeRefreshTokenRepo();
  const deviceRepo = new FakeDeviceRepo();
  const jwt = new FakeJwt();
  const tokenService = new TokenService(jwt, '15m', '30d');
  const auth = new AuthService(userRepo, subRepo, rtRepo, deviceRepo, tokenService, JWT_SECRET);
  return { auth, userRepo, planRepo, subRepo, rtRepo, deviceRepo, jwt, tokenService };
}

describe('AuthService.register', () => {
  it('creates a free user with a 14-day trial subscription and both tokens', async () => {
    const { auth, userRepo, subRepo } = setup();
    const before = Date.now();
    const res = await auth.register('a@example.com', 'password123', { deviceName: 'laptop' });

    expect(res.accessToken).toContain('"role":"user"');
    expect(res.accessToken).toContain('"plan":"free"');
    expect(res.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.user.email).toBe('a@example.com');
    expect(res.user.planCode).toBe('free');
    expect(res.subscription?.status).toBe('trialing');

    const trialDays = (res.subscription!.periodEndTime.getTime() - before) / 86400000;
    expect(trialDays).toBeGreaterThan(13.9);
    expect(trialDays).toBeLessThan(14.1);

    const stored = await userRepo.findByEmail('a@example.com');
    expect(stored?.lastLoginTime).toBeInstanceOf(Date);
    expect(subRepo.subs.size).toBe(1);
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
    expect(res.subscription?.status).toBe('trialing');
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

it('accepts a legacy sha256 password hash (migration path)', async () => {
    const { auth, userRepo } = setup();
    const { createHash } = await import('crypto');
    const legacy = createHash('sha256').update(`${JWT_SECRET}legacy-pass`).digest('hex');
    await userRepo.create('legacy@example.com', legacy, 'user', 'free');
    await expect(auth.login('legacy@example.com', 'legacy-pass')).resolves.toBeTruthy();
  });

  /**
   * 回归：旧 sha256 哈希登录成功后应就地升级为 scrypt。
   * `upgradePasswordIfNeeded` 此前无任何调用点，这批用户永远停在弱哈希，
   * 且其 legacySalt 取自 JWT_SECRET —— 轮换密钥后密码再也验不过。
   */
  it('登录后把 legacy sha256 升级为 scrypt', async () => {
    const { auth, userRepo } = setup();
    const { createHash } = await import('crypto');
    const legacy = createHash('sha256').update(`${JWT_SECRET}legacy-pass`).digest('hex');
    const created = await userRepo.create('up@example.com', legacy, 'user', 'free');

    expect((await userRepo.findById(created.id))!.passwordHash).toBe(legacy);
    await auth.login('up@example.com', 'legacy-pass');

    const after = (await userRepo.findById(created.id))!.passwordHash;
    expect(after.startsWith('scrypt$')).toBe(true);
    expect(after).not.toBe(legacy);
  });

  it('升级后仍能用同一密码登录（新旧哈希都验得过）', async () => {
    const { auth, userRepo } = setup();
    const { createHash } = await import('crypto');
    const legacy = createHash('sha256').update(`${JWT_SECRET}pw12345678`).digest('hex');
    await userRepo.create('twice@example.com', legacy, 'user', 'free');

    await expect(auth.login('twice@example.com', 'pw12345678')).resolves.toBeTruthy();
    // 第二次走的已是 scrypt 路径
    await expect(auth.login('twice@example.com', 'pw12345678')).resolves.toBeTruthy();
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
    const { auth, rtRepo, deviceRepo } = setup({ maxDevices: 1 });
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
    const { auth, rtRepo, deviceRepo } = setup({ maxDevices: 1 });
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
    const user = await userRepo.create('a@example.com', hashPassword('password123'), 'user', 'free');
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

  /**
   * 这条原来断言的是「未知 token 登出 = 什么都不做」，把一个缺陷钉成了期望值：
   * 登出的语义底线是当前会话必须死掉，而当前会话由 access token 里的 sid 标识，
   * 与客户端手上那个 refresh token 是否仍然有效无关。
   *
   * 现在断言正确行为：token 未知不影响 sid 对应会话被撤销；只有 sid 也不存在时
   * 才真的是 no-op。
   */
  it('未知 token 不阻止当前会话（sid）被撤销', async () => {
    const { auth, rtRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    const sid = [...rtRepo.tokens.values()].find((t) => !t.revokedTime)!.id;

    await auth.logout(sid, reg.user.id, 'never-issued');

    expect(await rtRepo.countActiveForUser(reg.user.id, new Date())).toBe(0);
  });

  it('sid 与 token 都不存在时才是 no-op', async () => {
    const { auth } = setup();
    await expect(auth.logout(9999, 1, 'never-issued')).resolves.toBeUndefined();
  });

  it('lists active sessions with device metadata and marks the current device', async () => {
    const { auth, rtRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123', { deviceName: 'laptop', ip: '1.1.1.1' });
    await auth.login('a@example.com', 'password123', { deviceName: 'phone', ip: '2.2.2.2' });
    const current = [...rtRepo.tokens.values()].find((t) => t.deviceName === 'phone')!;
    const sessions = await auth.listSessions(reg.user.id, current.id);
    expect(sessions.map((s) => s.deviceName)).toEqual(['laptop', 'phone']);
    expect(sessions.map((s) => s.ip)).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(sessions.map((s) => s.current)).toEqual([false, true]);
  });

  it('refuses to revoke a session belonging to another user', async () => {
    const { auth, rtRepo } = setup();
    const victim = await auth.register('victim@example.com', 'password123');
    const attacker = await auth.register('attacker@example.com', 'password123');
    const victimSession = [...rtRepo.tokens.values()].find((t) => t.userId === victim.user.id)!;

    await expect(auth.revokeSession(attacker.user.id, victimSession.id)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(victimSession.revokedTime).toBeUndefined();
  });

  it('revokes an own session', async () => {
    const { auth, rtRepo } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    const own = [...rtRepo.tokens.values()][0];
    await auth.revokeSession(reg.user.id, own.id);
    expect(own.revokedTime).toBeInstanceOf(Date);
  });

  it('rejects revoking a nonexistent session', async () => {
    const { auth } = setup();
    const reg = await auth.register('a@example.com', 'password123');
    await expect(auth.revokeSession(reg.user.id, 9999)).rejects.toBeInstanceOf(InvalidCredentialsError);
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
