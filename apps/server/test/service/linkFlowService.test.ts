import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { LinkFlowService } from '../../src/modules/auth/service/linkFlowService.js';
import { FakeMailFlowRepo } from '../helpers/linkFlowFakes.js';
import { FakeEmailVerificationTokenRepo, FakeUserRepo, FakeRateLimitRepo, FakeSyncResetTokenRepo } from '../helpers/fakeRepos.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const TOKEN = 'A'.repeat(43);

function hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function makeService(mailFlow = new FakeMailFlowRepo()) {
  const tokenRepo = new FakeEmailVerificationTokenRepo();
  const userRepo = new FakeUserRepo();
  const resetTokenRepo = new FakeSyncResetTokenRepo();
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), false);
  const service = new LinkFlowService(
    mailFlow,
    tokenRepo,
    resetTokenRepo,
    userRepo,
    async (fn) => fn({} as Queryable),
    rateLimiter,
  );
  return { service, tokenRepo, userRepo, mailFlow, resetTokenRepo };
}

describe('LinkFlowService.claim', () => {
  it('creates an issued mail flow and returns a nonce', async () => {
    const { service, mailFlow } = makeService();
    const result = await service.claim({ type: 'verify-email', token: TOKEN });
    expect(result.nonce).toBeTruthy();
    expect(result.created).toBe(true);
    const flows = [...mailFlow.store.values()];
    expect(flows).toHaveLength(1);
    expect(flows[0].type).toBe('verify-email');
    expect(flows[0].status).toBe('issued');
  });

  it('claim resolves sync-reset target_record_id from a reset token', async () => {
    const s = makeService();
    const raw = Buffer.alloc(32, 0);
    const resetTok = await s.resetTokenRepo.create({} as Queryable, {
      userId: 1, tokenHash: createHash('sha256').update(raw).digest(), expiresTime: new Date(Date.now() + 3600_000),
    });
    const result = await s.service.claim({ type: 'sync-reset', token: 'A'.repeat(43) });
    expect(result.created).toBe(true);
    const flows = [...s.mailFlow.store.values()];
    expect(flows[0].type).toBe('sync-reset');
    expect(flows[0].targetRecordId).toBe(resetTok.id);
  });

  it('rejects an unsupported type', async () => {
    const { service } = makeService();
    await expect(service.claim({ type: 'unknown-type', token: TOKEN })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a malformed token', async () => {
    const { service } = makeService();
    await expect(service.claim({ type: 'verify-email', token: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('reuses an existing issued flow for the same nonce + token', async () => {
    const { service, mailFlow } = makeService();
    const first = await service.claim({ type: 'verify-email', token: TOKEN });
    const second = await service.claim({ type: 'verify-email', token: TOKEN, existingNonce: first.nonce });
    expect(second.nonce).toBe(first.nonce);
    expect(second.created).toBe(false);
    expect(mailFlow.store.size).toBe(1);
  });
});

describe('LinkFlowService.verifyEmail', () => {
  it('consumes token + flow and marks the user verified', async () => {
    const { service, tokenRepo, userRepo, mailFlow } = makeService();
    const user = await userRepo.create('user@b.com', 'hash', undefined);
    await tokenRepo.create({} as Queryable, {
      userId: user.id,
      email: 'user@b.com',
      purpose: 'initial',
      tokenHash: hex(TOKEN),
      expiresTime: new Date(Date.now() + 60_000),
    });

    const { nonce } = await service.claim({ type: 'verify-email', token: TOKEN });
    await expect(service.verifyEmail(nonce)).resolves.toMatchObject({ ok: true });

    const token = await tokenRepo.findByHash(hex(TOKEN));
    expect(token!.consumedTime).toBeTruthy();
    const flow = mailFlow.store.get(createHash('sha256').update(nonce).digest().toString('hex'))!;
    expect(flow.status).toBe('consumed');
  });

  it('returns invalid for an unknown nonce', async () => {
    const { service } = makeService();
    await expect(service.verifyEmail('nonexistent')).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_INVALID' });
  });

  it('returns already-confirmed when the flow was consumed', async () => {
    const { service, tokenRepo, userRepo } = makeService();
    const user = await userRepo.create('user@b.com', 'hash', undefined);
    await tokenRepo.create({} as Queryable, {
      userId: user.id,
      email: 'user@b.com',
      purpose: 'initial',
      tokenHash: hex(TOKEN),
      expiresTime: new Date(Date.now() + 60_000),
    });
    const { nonce } = await service.claim({ type: 'verify-email', token: TOKEN });
    await service.verifyEmail(nonce);
    await expect(service.verifyEmail(nonce)).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_ALREADY_CONFIRMED' });
  });

  it('returns invalid when the underlying token is expired', async () => {
    const { service, tokenRepo, userRepo } = makeService();
    const user = await userRepo.create('expired@b.com', 'hash', undefined);
    await tokenRepo.create({} as Queryable, {
      userId: user.id,
      email: 'expired@b.com',
      purpose: 'initial',
      tokenHash: hex(TOKEN),
      expiresTime: new Date(Date.now() - 1000),
    });
    const { nonce } = await service.claim({ type: 'verify-email', token: TOKEN });
    await expect(service.verifyEmail(nonce)).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_INVALID' });
  });

  it('returns invalid when the mail flow itself is expired', async () => {
    const { service, tokenRepo, userRepo, mailFlow } = makeService();
    const user = await userRepo.create('flow@b.com', 'hash', undefined);
    await tokenRepo.create({} as Queryable, {
      userId: user.id,
      email: 'flow@b.com',
      purpose: 'initial',
      tokenHash: hex(TOKEN),
      expiresTime: new Date(Date.now() + 60_000),
    });
    const { nonce } = await service.claim({ type: 'verify-email', token: TOKEN });
    const nonceHash = createHash('sha256').update(nonce).digest().toString('hex');
    mailFlow.store.get(nonceHash)!.expiresTime = new Date(Date.now() - 1000);
    await expect(service.verifyEmail(nonce)).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_INVALID' });
  });

  it('returns already-confirmed when a different flow points at an already-consumed token', async () => {
    const { service, tokenRepo, userRepo } = makeService();
    const user = await userRepo.create('dup@b.com', 'hash', undefined);
    await tokenRepo.create({} as Queryable, {
      userId: user.id,
      email: 'dup@b.com',
      purpose: 'initial',
      tokenHash: hex(TOKEN),
      expiresTime: new Date(Date.now() + 60_000),
    });
    const first = await service.claim({ type: 'verify-email', token: TOKEN });
    await service.verifyEmail(first.nonce);
    const second = await service.claim({ type: 'verify-email', token: TOKEN });
    await expect(service.verifyEmail(second.nonce)).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_ALREADY_CONFIRMED' });
  });
});

describe('LinkFlowService.bindFlowToUser', () => {
  it('binds an issued flow and is idempotent for the same user', async () => {
    const deps = makeService();
    const { service } = deps;
    const user = await deps.userRepo.create('binder@b.com', 'hash', 'B');
    const { nonce } = await service.claim({ type: 'verify-email', token: 'A'.repeat(43) });
    await service.bindFlowToUser(nonce, user.id);
    await service.bindFlowToUser(nonce, user.id);
    const nonceHash = createHash('sha256').update(nonce).digest().toString('hex');
    expect(deps.mailFlow.store.get(nonceHash)!.userId).toBe(user.id);
  });

  it('throws when binding a flow already bound to another user', async () => {
    const deps = makeService();
    const { service } = deps;
    const user = await deps.userRepo.create('binder2@b.com', 'hash', 'B');
    const other = await deps.userRepo.create('other@b.com', 'hash', 'O');
    const { nonce } = await service.claim({ type: 'verify-email', token: 'A'.repeat(43) });
    await service.bindFlowToUser(nonce, user.id);
    await expect(service.bindFlowToUser(nonce, other.id)).rejects.toMatchObject({ code: 'LINK_FLOW_INVALID' });
  });
});