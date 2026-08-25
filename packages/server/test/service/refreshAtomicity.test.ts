import { describe, expect, it } from 'vitest';
import { AuthService } from '../../src/service/authService.js';
import { TokenService } from '../../src/service/tokenService.js';
import {
  FakeUserRepo,
  FakeSubscriptionRepo,
  FakeRefreshTokenRepo,
  FakeDeviceRepo,
} from '../helpers/fakeRepos.js';
import { hashPassword } from '../../src/service/password.js';
import { TokenReuseError } from '../../src/domain/errors.js';

/** 简易 JWT 端口：只需能签发/解析，签名正确性由别处覆盖 */
function makeJwt() {
  return {
    sign: (payload: object) => JSON.stringify(payload),
    verify: <T,>(token: string) => JSON.parse(token) as T,
  };
}

async function setup() {
  const userRepo = new FakeUserRepo();
  const subRepo = new FakeSubscriptionRepo();
  const rtRepo = new FakeRefreshTokenRepo();
  const deviceRepo = new FakeDeviceRepo();
  const tokenService = new TokenService(makeJwt(), '15m', '30d');
  const auth = new AuthService(userRepo, subRepo, rtRepo, deviceRepo, tokenService);
  const user = await userRepo.create('u@example.com', hashPassword('pw12345678'), 'user', 'free');
  return { auth, userRepo, rtRepo, tokenService, user };
}

/**
 * refresh token 消费的原子性。
 *
 * 原实现是「查 → 判 revokedTime → updateLastUsed → revoke → create」，五步之间
 * 有四个 await，每个都是事件循环的让出点，且 `revoke` 是无条件 UPDATE
 * （`WHERE id = ?`，不看 `revoked_time`，也不看 affectedRows）。
 *
 * 于是两个请求带着同一个 refresh token 并发到达时，双方都能在对方 revoke 之前
 * 通过 `if (rt.revokedTime)` 检查，各自签出一条新会话：
 *
 *  - refresh token 的「一次性」保证失效
 *  - `refresh_tokens` 出现两条活跃行，攻击者与受害者各持一条会话链
 *  - 重用检测（TOKEN_REUSE）在最需要它的并发场景下静默失灵
 *
 * 修复的判据是 `consume()` 的 affectedRows：条件更新
 * `WHERE id = ? AND revoked_time IS NULL` 只可能有一个赢家，输的那个一律按重用处理。
 */
describe('refresh 并发消费', () => {
  it('同一个 refresh token 并发刷新：恰好一个成功，另一个判为重用', async () => {
    const { auth, rtRepo, user } = await setup();
    const login = await auth.login('u@example.com', 'pw12345678');

    const results = await Promise.allSettled([
      auth.refresh(login.refreshToken),
      auth.refresh(login.refreshToken),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(TokenReuseError);

    // 判为重用后必须撤销该用户全部会话，包括刚签出的那条
    const active = (await rtRepo.listActiveForUser(user.id, new Date())).length;
    expect(active).toBe(0);
  });

  it('三个并发请求同样只有一个赢家', async () => {
    const { auth } = await setup();
    const login = await auth.login('u@example.com', 'pw12345678');

    const results = await Promise.allSettled([
      auth.refresh(login.refreshToken),
      auth.refresh(login.refreshToken),
      auth.refresh(login.refreshToken),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('顺序刷新照常工作（不误伤正常路径）', async () => {
    const { auth } = await setup();
    const login = await auth.login('u@example.com', 'pw12345678');

    const r1 = await auth.refresh(login.refreshToken);
    const r2 = await auth.refresh(r1.refreshToken);

    expect(r2.accessToken).toBeTruthy();
    expect(r2.refreshToken).not.toBe(r1.refreshToken);
  });

  it('重复使用已轮换的旧 token 仍判为重用', async () => {
    const { auth } = await setup();
    const login = await auth.login('u@example.com', 'pw12345678');
    await auth.refresh(login.refreshToken);

    await expect(auth.refresh(login.refreshToken)).rejects.toBeInstanceOf(TokenReuseError);
  });
});

/**
 * 登出的语义底线：**当前会话一定要死掉**。
 *
 * 原实现只按传入的 refresh token 查找并撤销，且「找不到」或「已撤销」都静默
 * 返回成功，同时完全不使用 `req.user.sid`（发起本次登出的那条会话的权威标识）。
 *
 * 真实攻击链：攻击者窃取 R1 并抢先 refresh → 服务端撤销 R1、签出攻击者的 R2。
 * 受害者察觉异常点「退出登录」，客户端发送它手上的 R1 → 服务端发现 R1 已撤销
 * → **无操作，返回 200** → 攻击者的 R2 会话（refresh 30 天有效）完好无损，
 * 而受害者以为自己已经登出了。
 *
 * 另外注意：同一个已撤销 token 出现在 refresh 时会触发 revokeAllForUser，
 * 出现在 logout 时却什么都不做 —— 面对同一个泄露信号，logout 的处置严格弱于
 * refresh，这个不对称本身就是缺陷。
 */
describe('logout 撤销当前会话', () => {
  it('撤销发起登出的那条会话（sid），即使传入的 refresh token 已失效', async () => {
    const { auth, rtRepo, user } = await setup();
    const login = await auth.login('u@example.com', 'pw12345678');
    // 攻击者抢先轮换：R1 被撤销，攻击者持有 R2
    const attacker = await auth.refresh(login.refreshToken);
    const attackerSid = [...rtRepo.tokens.values()].find((t) => !t.revokedTime)!.id;

    // 受害者用已失效的 R1 登出，但它的 access token 里的 sid 是有效的
    await auth.logout(attackerSid, user.id, login.refreshToken);

    const active = (await rtRepo.listActiveForUser(user.id, new Date())).length;
    expect(active).toBe(0);
    expect(attacker.refreshToken).toBeTruthy();
  });

  it('出示一个已被轮换掉的 token 时，按泄露处理撤销全部会话', async () => {
    const { auth, rtRepo, user } = await setup();
    const a = await auth.login('u@example.com', 'pw12345678');
    await auth.login('u@example.com', 'pw12345678'); // 第二台设备
    const rotated = await auth.refresh(a.refreshToken);
    expect(rotated.refreshToken).toBeTruthy();

    const currentSid = [...rtRepo.tokens.values()].filter((t) => !t.revokedTime)[0].id;
    // a.refreshToken 已被轮换掉 —— 与 refresh 侧同等对待
    await auth.logout(currentSid, user.id, a.refreshToken);

    expect((await rtRepo.listActiveForUser(user.id, new Date())).length).toBe(0);
  });

  it('正常登出只撤当前会话，不影响其他设备', async () => {
    const { auth, rtRepo, user } = await setup();
    const deviceA = await auth.login('u@example.com', 'pw12345678');
    await auth.login('u@example.com', 'pw12345678');
    const before = (await rtRepo.listActiveForUser(user.id, new Date())).length;
    expect(before).toBe(2);

    const sidA = [...rtRepo.tokens.values()].find(
      (t) => t.tokenHash === (auth as any).tokenService.hashToken(deviceA.refreshToken),
    )!.id;
    await auth.logout(sidA, user.id, deviceA.refreshToken);

    expect((await rtRepo.listActiveForUser(user.id, new Date())).length).toBe(1);
  });

  it('不接受他人的 sid（越权撤销）', async () => {
    const { auth, rtRepo, userRepo } = await setup();
    const victim = await userRepo.create('victim@example.com', hashPassword('pw12345678'), 'user', 'free');
    const victimSession = await rtRepo.create({
      userId: victim.id,
      tokenHash: 'victim-hash',
      expiresTime: new Date(Date.now() + 86400_000),
    } as any);
    const attacker = await auth.login('u@example.com', 'pw12345678');
    expect(attacker.refreshToken).toBeTruthy();

    // 攻击者拿受害者的 sid 调 logout
    await auth.logout(victimSession.id, (await userRepo.findByEmail('u@example.com'))!.id, undefined);

    // 受害者的会话必须还活着
    expect((await rtRepo.listActiveForUser(victim.id, new Date())).length).toBe(1);
  });

  it('不传 refresh token 也能登出当前会话', async () => {
    const { auth, rtRepo, user } = await setup();
    await auth.login('u@example.com', 'pw12345678');
    const sid = [...rtRepo.tokens.values()].find((t) => !t.revokedTime)!.id;

    await auth.logout(sid, user.id, undefined);

    expect((await rtRepo.listActiveForUser(user.id, new Date())).length).toBe(0);
  });
});
