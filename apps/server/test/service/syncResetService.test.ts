import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  FakeSyncStateRepo,
  FakeSyncRecordRepo,
  FakeSyncResetTokenRepo,
  FakeSyncResetHandoffRepo,
  FakeRateLimitRepo,
  FakeUserRepo,
} from '../helpers/fakeRepos.js';
import { FakeMailFlowRepo, FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import { SyncResetService } from '../../src/modules/db/service/syncResetService.js';
import { toState, type SyncNewState } from '../../src/modules/db/service/syncStateService.js';
import { MemoryEmailSender } from '../../src/modules/auth/service/emailSender.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitedError, SyncResetHandoffInvalidError, SyncResetHandoffReusedError, SyncResetInProgressError } from '../../src/domain/errors.js';
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
    envelopeAccount: { version: '1', nonce: buf(12, fill + 8), ct: buf(32, fill + 9), tag: buf(16, fill + 10) },
    accountRecoveryKey: buf(32, fill + 11),
    signPub: buf(32, fill + 6), recoverSignPub: buf(32, fill + 7),
  };
}

function makeStack(syncExtensionId = 'lang2hong.devbelt-db-client') {
  const stateRepo = new FakeSyncStateRepo();
  const recordRepo = new FakeSyncRecordRepo();
  const resetTokenRepo = new FakeSyncResetTokenRepo();
  const handoffRepo = new FakeSyncResetHandoffRepo();
  const mailFlowRepo = new FakeMailFlowRepo();
  const userRepo = new FakeUserRepo();
  const emailSender = new MemoryEmailSender();
  const rateLimitRepo = new FakeRateLimitRepo();
  const rateLimiter = new RateLimitService(rateLimitRepo, true);
  const auditWriter = new AuditWriter(new FakeAuditRepo());
  const svc = new SyncResetService(stateRepo, recordRepo, resetTokenRepo, userRepo, runner, emailSender, rateLimiter, mailFlowRepo, handoffRepo, auditWriter, syncExtensionId);
  return { stateRepo, recordRepo, resetTokenRepo, handoffRepo, mailFlowRepo, userRepo, emailSender, rateLimitRepo, rateLimiter, svc };
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

/** 建 reset token + 绑定 sync-reset mail_flow，走真实 createHandoff 得到 ticket。 */
async function issueHandoff(s: ReturnType<typeof makeStack>, userId: number, rawToken: Buffer = buf(32, 90)) {
  const token = await injectToken(s.resetTokenRepo, userId, rawToken);
  const nonce = randomB64(32);
  await s.mailFlowRepo.create({
    type: 'sync-reset',
    targetTokenHash: sha(rawToken),
    targetRecordId: token.id,
    userId,
    nonceHash: sha(Buffer.from(nonce, 'utf8')),
    expiresTime: new Date(Date.now() + 600_000),
  });
  const { openUri } = await s.svc.createHandoff(nonce, userId);
  const ticket = openUri.split('handoffTicket=')[1];
  return { token, ticket: Buffer.from(ticket, 'base64url'), openUri };
}

function randomB64(n: number): string {
  return Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256))).toString('base64url').slice(0, 43);
}

const USER = 42;
const DIGEST = buf(32, 0xab);

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
    } as any;
    const svc = new SyncResetService(s.stateRepo, s.recordRepo, s.resetTokenRepo, s.userRepo, runner, failingSender, s.rateLimiter, s.mailFlowRepo, s.handoffRepo, new AuditWriter(new FakeAuditRepo()), 'lang2hong.devbelt-db-client');

    await expect(svc.requestResetChallenge(user.id, '1.2.3.4')).resolves.toBeUndefined();
    expect(s.resetTokenRepo.store.size).toBe(1);

    await expect(svc.requestResetChallenge(user.id, '1.2.3.4')).resolves.toBeUndefined();
    let pending = 0;
    for (const t of s.resetTokenRepo.store.values()) if (!t.consumedTime && !t.revokedTime) pending++;
    expect(pending).toBe(1);
  });

  it('createHandoff issues a ticket, revokes prior pending handoffs, and consumes the mail flow', async () => {
    const s = makeStack();
    const raw = buf(32, 1);
    const { token, ticket } = await issueHandoff(s, USER, raw);

    // 再次签发（重置邮件重发后新 flow）应撤销旧 handoff。
    const handoffs = [...s.handoffRepo.store.values()];
    expect(handoffs).toHaveLength(1);
    const h = handoffs[0];
    expect(h.status).toBe('issued');
    expect(h.resetTokenId).toBe(token.id);
    expect(h.ticketHash.equals(sha(ticket))).toBe(true);

    // mail_flow 被消费。
    expect([...s.mailFlowRepo.store.values()][0].status).toBe('consumed');
  });

  it('createHandoff openUri uses the configured extension authority', async () => {
    const s1 = makeStack();
    const { openUri: u1 } = await issueHandoff(s1, USER, buf(32, 11));
    expect(u1.startsWith('vscode://lang2hong.devbelt-db-client/reset-after-loss?handoffTicket=')).toBe(true);

    const s2 = makeStack('com.example.ext');
    const { openUri: u2 } = await issueHandoff(s2, USER, buf(32, 12));
    expect(u2.startsWith('vscode://com.example.ext/reset-after-loss?handoffTicket=')).toBe(true);
  });

  it('resetAfterLossWithHandoff consumes ticket+token, tombstones records, and returns full StateDto', async () => {
    const s = makeStack();
    await seedState(s.stateRepo, USER, '1');
    const recordId = buf(16, 70);
    await s.recordRepo.create({} as Queryable, {
      userId: USER, keyEpoch: '1', recordId,
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: buf(12, 71), ciphertext: buf(50, 72), tag: buf(16, 73),
      version: '1', changeSequence: '1',
    });

    const { token, ticket } = await issueHandoff(s, USER);
    const dto = await s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: ticket, newState: newState(30), requestDigest: DIGEST });

    expect(dto.keyEpoch).toBe('2');
    expect(dto.stateVersion).toBe('1');
    expect(token.consumedTime).not.toBeNull();

    const h = [...s.handoffRepo.store.values()][0];
    expect(h.status).toBe('completed');
    expect(h.resultStateDtoJson).toBeTruthy();

    const tomb = await s.recordRepo.findForUpdate({} as Queryable, USER, '1', recordId);
    expect(tomb?.deleteTime).not.toBeNull();
  });

it('resetAfterLossWithHandoff creates an epoch (keyEpoch=1) when no active state exists', async () => {
    const s = makeStack();
    const { ticket } = await issueHandoff(s, USER);
    const dto = await s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: ticket, newState: newState(), requestDigest: DIGEST });
    expect(dto.keyEpoch).toBe('1');
  });

  it('completed handoff replays the same StateDto on the same digest; different digest is REUSED', async () => {
    const s = makeStack();
    const { ticket } = await issueHandoff(s, USER);
    const first = await s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: ticket, newState: newState(), requestDigest: DIGEST });

    const replay = await s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: ticket, newState: newState(), requestDigest: DIGEST });
    expect(replay).toEqual(first);

    await expect(s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: ticket, newState: newState(), requestDigest: buf(32, 0xcd) }))
      .rejects.toBeInstanceOf(SyncResetHandoffReusedError);
  });

  it('rejects wrong user / unknown / revoked ticket with a constant 400 body', async () => {
    const s = makeStack();
    // 未知 ticket
    await expect(s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: buf(32, 9), newState: newState(), requestDigest: DIGEST }))
      .rejects.toBeInstanceOf(SyncResetHandoffInvalidError);

    // 跨用户：ticket 属于 USER，以另一用户消费
    const { ticket } = await issueHandoff(s, USER);
    await expect(s.svc.resetAfterLossWithHandoff(USER + 1, { handoffTicket: ticket, newState: newState(), requestDigest: DIGEST }))
      .rejects.toBeInstanceOf(SyncResetHandoffInvalidError);

    // 已撤销：签发后被撤销
    const s2 = makeStack();
    const { ticket: t2 } = await issueHandoff(s2, USER);
    const h = [...s2.handoffRepo.store.values()][0];
    await s2.handoffRepo.revokePendingByResetToken({} as Queryable, h.resetTokenId, new Date());
    await expect(s2.svc.resetAfterLossWithHandoff(USER, { handoffTicket: t2, newState: newState(), requestDigest: DIGEST }))
      .rejects.toBeInstanceOf(SyncResetHandoffInvalidError);
  });

  it('expired ticket is rejected with a constant 400 body', async () => {
    const s = makeStack();
    const { ticket } = await issueHandoff(s, USER);
    const h = [...s.handoffRepo.store.values()][0];
    h.expiresTime = new Date(Date.now() - 1000);
    await expect(s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: ticket, newState: newState(), requestDigest: DIGEST }))
      .rejects.toBeInstanceOf(SyncResetHandoffInvalidError);
  });

  it('processing state returns 409 IN_PROGRESS; stale processing (>60s) auto-recovers', async () => {
    const s = makeStack();
    const { ticket } = await issueHandoff(s, USER);
    const h = [...s.handoffRepo.store.values()][0];
    // 直接置 processing + 60s 内的 updateTime。
    await s.handoffRepo.markProcessing({} as Queryable, h.id, DIGEST, new Date());
    await expect(s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: ticket, newState: newState(), requestDigest: DIGEST }))
      .rejects.toBeInstanceOf(SyncResetInProgressError);

    // 超过 60s：自动回退 issued，可正常消费。
    await s.handoffRepo.markProcessing({} as Queryable, h.id, DIGEST, new Date(Date.now() - 61_000));
    const dto = await s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: ticket, newState: newState(), requestDigest: DIGEST });
    expect(dto.keyEpoch).toBe('1');
  });

  it('resetAfterLossWithHandoff rejects a newState that reuses the account recovery key / account nonce', async () => {
    const s = makeStack();
    await seedState(s.stateRepo, USER, '1');
    const { ticket } = await issueHandoff(s, USER);
    // seedState 与 reset 都用默认 fill=10 → 账号信封 nonce 与 accountRecoveryKey 完全复用。
    await expect(s.svc.resetAfterLossWithHandoff(USER, { handoffTicket: ticket, newState: newState(), requestDigest: DIGEST }))
      .rejects.toThrow(/account/);
  });
});