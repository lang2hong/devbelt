import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  FakeUserRepo,
  FakeEmailVerificationTokenRepo,
  FakePersonalPlanRepo,
  FakePersonalSubscriptionRepo,
  FakeDeviceRepo,
  FakeRefreshTokenRepo,
  FakeRateLimitRepo,
  FakeRegistrationRepo,
} from '../helpers/fakeRepos.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { AuthService, type DeviceFields } from '../../src/service/authService.js';
import { ConsoleAuthService } from '../../src/service/consoleAuthService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import { hashPassword } from '../../src/service/password.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const PASSWORD = 'correct-horse-battery';

const device = (key: string, platform: string): DeviceFields => ({
  deviceKey: key,
  devicePlatform: platform,
  deviceName: 'd',
  clientVersion: '1.0.0',
});

describe('web device quota isolation (§4.1)', () => {
  it('excludes the web slot from extension maxDevices and rejects spoofing', async () => {
    const userRepo = new FakeUserRepo();
    const personalPlanRepo = new FakePersonalPlanRepo();
    const personalSubscriptionRepo = new FakePersonalSubscriptionRepo();
    const deviceRepo = new FakeDeviceRepo();
    const refreshTokenRepo = new FakeRefreshTokenRepo();
    const tokenRepo = new FakeEmailVerificationTokenRepo();
    const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), false);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
    const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
    const runner = async (fn: (tx: Queryable) => Promise<any>) => fn({} as Queryable);

    const auth = new AuthService(
      userRepo,
      tokenRepo,
      personalSubscriptionRepo,
      deviceRepo,
      refreshTokenRepo,
      new FakeRegistrationRepo(personalPlanRepo, userRepo, personalSubscriptionRepo, tokenRepo),
      tokenService,
      new MemoryEmailSender(),
      rateLimiter,
      runner,
    );
    const consoleAuth = new ConsoleAuthService(userRepo, deviceRepo, refreshTokenRepo, tokenService, rateLimiter, runner);

    const passwordHash = await hashPassword(PASSWORD);
    const u = await userRepo.create('q@b.com', passwordHash, 'Q');
    await userRepo.markEmailVerified({} as Queryable, u.id, new Date());

    // maxDevices = 1（只允许 1 台扩展设备）
    const plan = (await personalPlanRepo.findByCode('free'))!;
    await personalSubscriptionRepo.create({
      userId: u.id,
      planId: plan.id,
      status: 'active',
      entitlementSnapshot: { maxDevices: 1 },
      periodStartTime: new Date(),
      periodEndTime: null,
    });

    // 先登录 Web Console（占用 web 槽位）
    await consoleAuth.login('q@b.com', PASSWORD, 'web-session-key-01');

    // 扩展登录不应被 web 槽位挤占配额
    await expect(auth.login('q@b.com', PASSWORD, device('ext-key-1', 'linux'))).resolves.toMatchObject({});

    // 扩展谎报 platform='web' 必须被拒
    await expect(auth.login('q@b.com', PASSWORD, device('ext-key-2', 'web'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});