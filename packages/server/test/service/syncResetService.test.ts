import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  FakeSyncStateRepo,
  FakeSyncRecordRepo,
  FakeSyncResetTokenRepo,
  FakeRateLimitRepo,
  FakeUserRepo,
} from '../helpers/fakeRepos.js';
import { SyncResetService } from '../../src/service/syncResetService.js';
import { toState, type SyncNewState } from '../../src/service/syncStateService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { RateLimitedError } from '../../src/domain/errors.js';
import type { SmpKdf, RecoveryKdf } from '../../src/domain/entities.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const runner = ((fn: any) => fn({} as Queryable));

function buf(n: number, fill = 1): Buffer { return Buffer.alloc(n, fill); }
function sha(raw: Buffer): Buffer { return createHash('sha256').update(raw).digest(); }

function smpKdf(): SmpKdf {
  return { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: buf(16, 2), outputBytes: 32 };
}
function recoveryKdf(): RecoveryKdf {
  return { alg: 'hkdf-sha256', version: 1, salt: buf(16, 3), outputBytes: 32 };
}

function newState(fill = 10): SyncNewState {
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    smpKdf: smpKdf(), recoveryKdf: recoveryKdf(),
    envelopeSmp: { version: '1', nonce: buf(12, fill), ct: buf(32, fill + 1), tag: buf(16, fill + 2) },
    envelopeRecovery: { version: '1', nonce: buf(12, fill + 3), ct: buf(32, fill + 4), tag: buf(16, fill + 5) },
    signPub: buf(32, fill + 6), recoverSignPub: buf(32, fill + 7),
  };
}

function makeStack() {
  const stateRepo = new FakeSyncStateRepo();
  const recordRepo = new FakeSyncRecordRepo();
  const resetTokenRepo = new FakeSyncResetTokenRepo();
  const userRepo = new FakeUserRepo();
  const emailSender = new MemoryEmailSender();
  const rateLimitRepo = new FakeRateLimitRepo();
  const rateLimiter = new RateLimitService(rateLimitRepo, true);
  const svc = new SyncResetService(stateRepo, recordRepo, resetTokenRepo, userRepo, runner, emailSender, rateLimiter);
  return { stateRepo, recordRepo, resetTokenRepo, userRepo, emailSender, rateLimitRepo, rateLimiter, svc };
}

async function makeVerifiedUser(userRepo: FakeUserRepo, email: string) {
  const u = await userRepo.create(email, 'h');
  await userRepo.markEmailVerified({} as Queryable, u.id, new Date());
  return u;
}

async function seedState(stateRepo: FakeSyncStateRepo, userId: number, changeSequence = '0'): Promise<void> {
  await stateRepo.create({} as Queryable, toState(userId, '1', '1', changeSequence, newState(), new Date()));
}

function injectToken(resetTokenRepo: FakeSyncResetTokenRepo, userId: number, raw: Buffer) {
  return resetTokenRepo.create({} as Queryable, {
    userId, tokenHash: sha(raw), expiresTime: new Date(Date.now() + 3600_000),
  });
}

const USER = 42;

describe('SyncResetService', () => {
  it('reset-challenges issues a token, emails it, and revokes the previous pending token', async () => {
    const s = makeStack();
    const user = await makeVerifiedUser(s.userRepo, 'alice@b.com');
    const ip = '1.2.3.4';

    await s.svc.requestResetChallenge(user.id, ip);
    expect(s.emailSender.sent).toHaveLength(1);
    expect(s.emailSender.sent[0].kind).toBe('reset_challenge');
    expect(s.emailSender.sent[0].to).toBe('alice@b.com');
    const first = s.emailSender.sent[0].token!;

    await s.svc.requestResetChallenge(user.id, ip);
    expect(s.emailSender.sent).toHaveLength(2);
    expect(s.emailSender.sent[1].token).not.toBe(first);

    let pending = 0;
    for (const t of s.resetTokenRepo.store.values()) if (!t.consumedTime && !t.revokedTime) pending++;
    expect(pending).toBe(1);
  });

  it('reset-challenges is rate-limited (3/hour) per user and per IP', async () => {
    const s = makeStack();
    const user = await makeVerifiedUser(s.userRepo, 'bob@b.com');
    const ip = '9.9.9.9';
    for (let i = 0; i < 3; i++) await s.svc.requestResetChallenge(user.id, ip);
    await expect(s.svc.requestResetChallenge(user.id, ip)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('reset-challenges does not send a challenge to an unverified email (uniform no-op)', async () => {
    const s = makeStack();
    const user = await s.userRepo.create('unverified@b.com', 'h'); // emailVerifiedTime = null
    await s.svc.requestResetChallenge(user.id, '1.1.1.1');
    expect(s.emailSender.sent).toHaveLength(0);
    expect(s.resetTokenRepo.store.size).toBe(0);
  });

  it('reset-challenges throttles the same user across different IPs', async () => {
    const s = makeStack();
    const user = await makeVerifiedUser(s.userRepo, 'ipuser@b.com');
    for (let i = 0; i < 3; i++) await s.svc.requestResetChallenge(user.id, `10.0.0.${i}`);
    await expect(s.svc.requestResetChallenge(user.id, '10.0.0.99')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('reset-challenges throttles the same IP across different users', async () => {
    const s = makeStack();
    const ip = '8.8.8.8';
    const u1 = await makeVerifiedUser(s.userRepo, 'ipu1@b.com');
    for (let i = 0; i < 3; i++) await s.svc.requestResetChallenge(u1.id, ip);
    const u2 = await makeVerifiedUser(s.userRepo, 'ipu2@b.com');
    await expect(s.svc.requestResetChallenge(u2.id, ip)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('reset-challenges tolerates email failure without rollback; a later resend still revokes + recreates', async () => {
    const s = makeStack();
    const user = await makeVerifiedUser(s.userRepo, 'smtpdown@b.com');
    const failingSender = {
      sendVerificationEmail: async () => {},
      sendAlreadyRegisteredEmail: async () => {},
      sendInvitationEmail: async () => {},
      sendResetChallengeEmail: async () => { throw new Error('smtp down'); },
    };
    const svc = new SyncResetService(s.stateRepo, s.recordRepo, s.resetTokenRepo, s.userRepo, runner, failingSender, s.rateLimiter);

    await expect(svc.requestResetChallenge(user.id, '1.2.3.4')).resolves.toBeUndefined();
    expect(s.resetTokenRepo.store.size).toBe(1);

    await expect(svc.requestResetChallenge(user.id, '1.2.3.4')).resolves.toBeUndefined();
    let pending = 0;
    for (const t of s.resetTokenRepo.store.values()) if (!t.consumedTime && !t.revokedTime) pending++;
    expect(pending).toBe(1);
  });

  it('reset-after-loss consumes token, tombstones records, and creates a new epoch', async () => {
    const s = makeStack();
    await seedState(s.stateRepo, USER, '1');
    const recordId = buf(16, 70);
    await s.recordRepo.create({} as Queryable, {
      userId: USER, keyEpoch: '1', recordId,
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: buf(12, 71), ciphertext: buf(50, 72), tag: buf(16, 73),
      version: '1', changeSequence: '1',
    });

    const raw = buf(32, 90);
    const token = await injectToken(s.resetTokenRepo, USER, raw);
    const res = await s.svc.resetAfterLoss(USER, { resetToken: raw, newState: newState() });

    expect(res).toEqual({ keyEpoch: '2', stateVersion: '1', changeSequence: '2' });
    expect(token.consumedTime).not.toBeNull();

    const tomb = await s.recordRepo.findForUpdate({} as Queryable, USER, '1', recordId);
    expect(tomb?.deleteTime).not.toBeNull();
    expect(tomb?.version).toBe('2');
    expect((await s.recordRepo.countActive({} as Queryable, USER, '1')).count).toBe(0);

    const state = await s.stateRepo.findByUserId(USER);
    expect(state?.keyEpoch).toBe('2');
    expect(state?.stateVersion).toBe('1');
    expect(state?.changeSequence).toBe('2');
  });

  it('reset-after-loss creates an epoch (keyEpoch=1) when no active state exists', async () => {
    const s = makeStack();
    const raw = buf(32, 91);
    await injectToken(s.resetTokenRepo, USER, raw);
    const res = await s.svc.resetAfterLoss(USER, { resetToken: raw, newState: newState() });

    expect(res).toEqual({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    const state = await s.stateRepo.findByUserId(USER);
    expect(state?.keyEpoch).toBe('1');
    expect(state?.stateVersion).toBe('1');
    expect(state?.changeSequence).toBe('0');
  });

  it('reset-after-loss rejects unknown / expired / consumed / cross-user token with a constant 400 body', async () => {
    const s = makeStack();
    await seedState(s.stateRepo, USER);
    const invalid = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: 'reset token invalid' });

    // 未知 token
    await invalid(s.svc.resetAfterLoss(USER, { resetToken: buf(32, 1), newState: newState() }));

    // 过期 token
    const expiredRaw = buf(32, 5);
    await s.resetTokenRepo.create({} as Queryable, { userId: USER, tokenHash: sha(expiredRaw), expiresTime: new Date(Date.now() - 1000) });
    await invalid(s.svc.resetAfterLoss(USER, { resetToken: expiredRaw, newState: newState() }));

    // 已消费 token
    const consumedRaw = buf(32, 2);
    await injectToken(s.resetTokenRepo, USER, consumedRaw);
    await s.svc.resetAfterLoss(USER, { resetToken: consumedRaw, newState: newState() });
    await invalid(s.svc.resetAfterLoss(USER, { resetToken: consumedRaw, newState: newState() }));

    // 跨用户：token 属于 USER，却以另一用户消费
    const otherRaw = buf(32, 3);
    await injectToken(s.resetTokenRepo, USER, otherRaw);
    await invalid(s.svc.resetAfterLoss(USER + 1, { resetToken: otherRaw, newState: newState() }));
  });

  it('revoked token is rejected with a constant 400 body', async () => {
    const s = makeStack();
    await seedState(s.stateRepo, USER);
    const raw = buf(32, 4);
    await injectToken(s.resetTokenRepo, USER, raw);
    await s.resetTokenRepo.revokePendingByUser({} as Queryable, USER, new Date());
    await expect(s.svc.resetAfterLoss(USER, { resetToken: raw, newState: newState() }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: 'reset token invalid' });
  });
});
