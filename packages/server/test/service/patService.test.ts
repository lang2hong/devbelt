import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { PatService } from '../../src/service/patService.js';
import { PlanPolicy } from '../../src/policy/planPolicy.js';
import { EntityNotFoundError, QuotaExceededError } from '../../src/domain/errors.js';
import { FakePatRepo, FakeUserRepo, FakePlanRepo, makePlan } from '../helpers/fakeRepos.js';

async function setup(maxPats: number) {
  const patRepo = new FakePatRepo();
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([makePlan('free', { maxPats })]);
  const policy = new PlanPolicy((code) => planRepo.findByCode(code));
  const service = new PatService(patRepo, userRepo, policy);
  const user = await userRepo.create('a@example.com', 'scrypt$x$y', 'user', 'free');
  return { service, patRepo, userRepo, user };
}

describe('PatService.create', () => {
  it('returns the plaintext token once and stores only its sha256', async () => {
    const { service, patRepo } = await setup(5);
    const { pat, token } = await service.create(1, 'ci-token', 'sync:read');

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pat.name).toBe('ci-token');
    expect(pat.scopes).toBe('sync:read');
    expect('tokenHash' in pat).toBe(false);

    const stored = patRepo.pats.get(pat.id)!;
    expect(stored.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(stored.tokenHash).not.toBe(token);
  });

  it('issues a distinct token per call', async () => {
    const { service } = await setup(5);
    const a = await service.create(1, 'a', 'sync:read');
    const b = await service.create(1, 'b', 'sync:read');
    expect(a.token).not.toBe(b.token);
  });

  it('makes the token findable by hash (auth lookup path)', async () => {
    const { service, patRepo } = await setup(5);
    const { token } = await service.create(1, 'ci', 'sync:write');
    const hash = createHash('sha256').update(token).digest('hex');
    await expect(patRepo.findByHash(hash)).resolves.toBeDefined();
  });

  it('rejects an unknown user', async () => {
    const { service } = await setup(5);
    await expect(service.create(4242, 'x', 'sync:read')).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('enforces the max_pats quota', async () => {
    const { service } = await setup(2);
    await service.create(1, 'a', 'sync:read');
    await service.create(1, 'b', 'sync:read');
    const err = await service.create(1, 'c', 'sync:read').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).quota).toBe('pats');
  });

  it('frees quota once a token is revoked', async () => {
    const { service } = await setup(1);
    const first = await service.create(1, 'a', 'sync:read');
    await expect(service.create(1, 'b', 'sync:read')).rejects.toBeInstanceOf(QuotaExceededError);
    await service.revoke(1, first.pat.id);
    await expect(service.create(1, 'b', 'sync:read')).resolves.toBeTruthy();
  });

  it('treats max_pats 0 as unlimited', async () => {
    const { service } = await setup(0);
    for (let i = 0; i < 4; i++) await service.create(1, `t${i}`, 'sync:read');
    await expect(service.list(1)).resolves.toHaveLength(4);
  });
});

describe('PatService.list', () => {
  it('never returns tokenHash', async () => {
    const { service } = await setup(5);
    await service.create(1, 'a', 'sync:read');
    const list = await service.list(1);
    expect(list).toHaveLength(1);
    for (const p of list) expect('tokenHash' in p).toBe(false);
  });

  it('scopes results to the owning user', async () => {
    const { service, userRepo } = await setup(5);
    await userRepo.create('b@example.com', 'scrypt$x$y', 'user', 'free');
    await service.create(1, 'mine', 'sync:read');
    await service.create(2, 'theirs', 'sync:read');

    expect((await service.list(1)).map((p) => p.name)).toEqual(['mine']);
    expect((await service.list(2)).map((p) => p.name)).toEqual(['theirs']);
  });

  it('still lists revoked tokens (with revokedTime set)', async () => {
    const { service } = await setup(5);
    const { pat } = await service.create(1, 'a', 'sync:read');
    await service.revoke(1, pat.id);
    const list = await service.list(1);
    expect(list[0].revokedTime).toBeInstanceOf(Date);
  });
});

describe('PatService.revoke', () => {
  it('revokes an own token', async () => {
    const { service, patRepo } = await setup(5);
    const { pat } = await service.create(1, 'a', 'sync:read');
    await service.revoke(1, pat.id);
    expect(patRepo.pats.get(pat.id)!.revokedTime).toBeInstanceOf(Date);
  });

  it('refuses to revoke another user token', async () => {
    const { service, userRepo, patRepo } = await setup(5);
    await userRepo.create('b@example.com', 'scrypt$x$y', 'user', 'free');
    const victim = await service.create(1, 'victim', 'sync:read');

    await expect(service.revoke(2, victim.pat.id)).rejects.toBeInstanceOf(EntityNotFoundError);
    expect(patRepo.pats.get(victim.pat.id)!.revokedTime).toBeUndefined();
  });

  it('rejects a nonexistent id', async () => {
    const { service } = await setup(5);
    await expect(service.revoke(1, 9999)).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});
