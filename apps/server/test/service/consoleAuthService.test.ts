import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  FakeUserRepo,
  FakeDeviceRepo,
  FakeRefreshTokenRepo,
  FakeRateLimitRepo,
} from '../helpers/fakeRepos.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { ConsoleAuthService } from '../../src/service/consoleAuthService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { hashPassword } from '../../src/service/password.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const PASSWORD = 'correct-horse-battery';

interface Fixture {
  svc: ConsoleAuthService;
  tokenService: TokenService;
  userRepo: FakeUserRepo;
  deviceRepo: FakeDeviceRepo;
  refreshTokenRepo: FakeRefreshTokenRepo;
}

function makeFixture(): Fixture {
  const userRepo = new FakeUserRepo();
  const deviceRepo = new FakeDeviceRepo();
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), false);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const svc = new ConsoleAuthService(userRepo, deviceRepo, refreshTokenRepo, tokenService, rateLimiter, async (fn) => fn({} as Queryable));
  return { svc, tokenService, userRepo, deviceRepo, refreshTokenRepo };
}

async function makeLoginableUser(f: Fixture, email = 'web@b.com'): Promise<number> {
  const passwordHash = await hashPassword(PASSWORD);
  const user = await f.userRepo.create(email, passwordHash, 'Web User');
  await f.userRepo.markEmailVerified({} as Queryable, user.id, new Date());
  return user.id;
}

describe('ConsoleAuthService', () => {
  it('login signs a console token and creates a web device slot', async () => {
    const f = makeFixture();
    const userId = await makeLoginableUser(f);

    const r = await f.svc.login('web@b.com', PASSWORD, 'browser-key-1');
    expect(r.user.userId).toBe(String(userId));

    const payload = await f.tokenService.verifyAccessToken(r.accessToken);
    expect(payload.aud).toBe('console');
    expect(payload.sessionId).toBe(r.familyId);
    expect(payload.deviceId).toBeTypeOf('number');
    expect(payload.scope).toContain('console');

    const web = await f.deviceRepo.findActiveByUserAndPlatform({} as Queryable, userId, 'web');
    expect(web).toBeTruthy();
    expect(web!.deviceKey).toBe('browser-key-1');
    expect(f.refreshTokenRepo.hasActiveToken(r.familyId)).resolves.toBe(true);
  });

  it('a new device key claims the single web slot and revokes the old family', async () => {
    const f = makeFixture();
    const userId = await makeLoginableUser(f, 'slot@b.com');

    const first = await f.svc.login('slot@b.com', PASSWORD, 'browser-key-1');
    const second = await f.svc.login('slot@b.com', PASSWORD, 'browser-key-2');

    // 旧 family 被原子撤销
    expect(await f.refreshTokenRepo.hasActiveToken(first.familyId)).toBe(false);
    expect(await f.refreshTokenRepo.hasActiveToken(second.familyId)).toBe(true);

    // 单槽位：active web 设备只有一个，且是新 key
    const active = [...f.deviceRepo.store.values()].filter((d) => d.userId === userId && d.devicePlatform === 'web' && d.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].deviceKey).toBe('browser-key-2');
  });

  it('refresh rotates tokens in the same family (session binds by family id)', async () => {
    const f = makeFixture();
    await makeLoginableUser(f, 'ref@b.com');
    const login = await f.svc.login('ref@b.com', PASSWORD, 'browser-key-1');

    const renewed = await f.svc.refresh(login.refreshToken);
    expect(renewed.accessToken).not.toBe(login.accessToken);

    const payload = await f.tokenService.verifyAccessToken(renewed.accessToken);
    expect(payload.sessionId).toBe(login.familyId); // family 不变
  });

  it('sessionIdOf resolves the family id from a refresh token', async () => {
    const f = makeFixture();
    await makeLoginableUser(f, 'sid@b.com');
    const login = await f.svc.login('sid@b.com', PASSWORD, 'browser-key-1');
    expect(await f.svc.sessionIdOf(login.refreshToken)).toBe(login.familyId);
  });

  it('logout consumes the refresh token', async () => {
    const f = makeFixture();
    await makeLoginableUser(f, 'out@b.com');
    const login = await f.svc.login('out@b.com', PASSWORD, 'browser-key-1');
    await f.svc.logout(login.refreshToken);
    expect(await f.refreshTokenRepo.hasActiveToken(login.familyId)).toBe(false);
  });
});