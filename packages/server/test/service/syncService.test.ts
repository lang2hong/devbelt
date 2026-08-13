import { describe, it, expect } from 'vitest';
import { SyncService } from '../../src/service/syncService.js';
import { PlanPolicy } from '../../src/policy/planPolicy.js';
import {
  EntityNotFoundError,
  ConflictError,
  VersionNotFoundError,
  QuotaExceededError,
} from '../../src/domain/errors.js';
import { FakeSyncRepo, FakeUserRepo, FakePlanRepo, makePlan } from '../helpers/fakeRepos.js';

async function setup(over: Parameters<typeof makePlan>[1] = {}) {
  const syncRepo = new FakeSyncRepo();
  const userRepo = new FakeUserRepo();
  const plan = makePlan('free', { syncQuotaBytes: 0, syncVersionRetention: 0, ...over });
  const planRepo = new FakePlanRepo([plan]);
  const policy = new PlanPolicy((code) => planRepo.findByCode(code));
  const service = new SyncService(syncRepo, userRepo, policy);
  const user = await userRepo.create('a@example.com', 'scrypt$x$y', 'user', 'free');
  return { service, syncRepo, userRepo, plan, user };
}

describe('SyncService.push', () => {
  it('writes version 1 from baseVersion 0 and records a history snapshot', async () => {
    const { service, syncRepo, user } = await setup();

    const res = await service.push(user.id, 'connections', 'cipher-a', 0);

    expect(res).toEqual({ version: 1 });
    const section = await syncRepo.getSection(user.id, 'connections');
    expect(section?.encryptedData).toBe('cipher-a');
    expect(section?.version).toBe(1);
    expect(syncRepo.historyVersions(user.id, 'connections')).toEqual([1]);
  });

  it('increments the version on each successful push', async () => {
    const { service, user } = await setup();
    expect(await service.push(user.id, 'queries', 'v1', 0)).toEqual({ version: 1 });
    expect(await service.push(user.id, 'queries', 'v2', 1)).toEqual({ version: 2 });
    expect(await service.push(user.id, 'queries', 'v3', 2)).toEqual({ version: 3 });
  });

  it('rejects a stale baseVersion with the server version attached', async () => {
    const { service, syncRepo, user } = await setup();
    await service.push(user.id, 'connections', 'v1', 0);

    const err = await service.push(user.id, 'connections', 'stale', 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).current).toBe(1);
    expect((err as ConflictError).base).toBe(0);
    expect((await syncRepo.getSection(user.id, 'connections'))!.encryptedData).toBe('v1');
  });

  it('keeps sections independent (per-section version counters)', async () => {
    const { service, user } = await setup();
    await service.push(user.id, 'connections', 'c1', 0);
    await expect(service.push(user.id, 'queries', 'q1', 0)).resolves.toEqual({ version: 1 });
  });

  it('rejects an unknown user before any write', async () => {
    const { service, syncRepo } = await setup();
    await expect(service.push(4242, 'connections', 'x', 0)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    expect(await syncRepo.getSection(4242, 'connections')).toBeUndefined();
  });

  it('skips the history snapshot for an empty payload', async () => {
    const { service, syncRepo, user } = await setup();
    await service.push(user.id, 'history', '', 0);
    expect((await syncRepo.getSection(user.id, 'history'))!.version).toBe(1);
    expect(syncRepo.historyVersions(user.id, 'history')).toEqual([]);
  });
});

describe('SyncService.push — quota is enforced before the write', () => {
  it('does not persist the payload when the projected total exceeds the quota', async () => {
    const { service, syncRepo, user } = await setup({ syncQuotaBytes: 100 });
    await service.push(user.id, 'connections', 'a'.repeat(50), 0);

    const err = await service
      .push(user.id, 'queries', 'b'.repeat(60), 0)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).quota).toBe('sync_bytes');
    expect((err as QuotaExceededError).current).toBe(110);
    expect((err as QuotaExceededError).limit).toBe(100);
    // 关键回归点：超额密文不得落库，否则 403 只是事后通知
    expect(await syncRepo.getSection(user.id, 'queries')).toBeUndefined();
    expect(syncRepo.historyVersions(user.id, 'queries')).toEqual([]);
    expect(await syncRepo.sumBytes(user.id)).toBe(50);
  });

  it('uses replacement semantics: the old bytes of the same section are subtracted', async () => {
    const { service, user } = await setup({ syncQuotaBytes: 100 });
    await service.push(user.id, 'connections', 'a'.repeat(90), 0);

    // 90 → 95 同节替换：投影 = 90 - 90 + 95 = 95 < 100
    await expect(service.push(user.id, 'connections', 'b'.repeat(95), 1)).resolves.toEqual({
      version: 2,
    });
  });

  it('rejects exactly at the quota boundary (>= limit)', async () => {
    const { service, user } = await setup({ syncQuotaBytes: 100 });
    await expect(service.push(user.id, 'connections', 'a'.repeat(99), 0)).resolves.toEqual({
      version: 1,
    });
    await expect(service.push(user.id, 'connections', 'a'.repeat(100), 1)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it('counts bytes, not characters (multi-byte payloads)', async () => {
    const { service, user } = await setup({ syncQuotaBytes: 100 });
    // 40 个三字节字符 = 120 字节
    await expect(service.push(user.id, 'connections', '中'.repeat(40), 0)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    await expect(service.push(user.id, 'connections', '中'.repeat(30), 0)).resolves.toEqual({
      version: 1,
    });
  });

  it('treats syncQuotaBytes 0 as unlimited', async () => {
    const { service, user } = await setup({ syncQuotaBytes: 0 });
    await expect(service.push(user.id, 'connections', 'x'.repeat(100000), 0)).resolves.toEqual({
      version: 1,
    });
  });

  it('checks the quota before the optimistic-lock check', async () => {
    const { service, syncRepo, user } = await setup({ syncQuotaBytes: 100 });
    await service.push(user.id, 'connections', 'a'.repeat(90), 0);

    // baseVersion 也是错的，但配额先失败
    await expect(service.push(user.id, 'queries', 'b'.repeat(50), 7)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(await syncRepo.getSection(user.id, 'queries')).toBeUndefined();
  });
});

describe('SyncService.push — version retention', () => {
  it('prunes history down to the plan retention, keeping the newest', async () => {
    const { service, syncRepo, user } = await setup({ syncVersionRetention: 2 });
    await service.push(user.id, 'connections', 'v1', 0);
    await service.push(user.id, 'connections', 'v2', 1);
    await service.push(user.id, 'connections', 'v3', 2);

    expect(syncRepo.historyVersions(user.id, 'connections')).toEqual([2, 3]);
  });

  it('keeps every snapshot when retention is 0 (no pruning)', async () => {
    const { service, syncRepo, user } = await setup({ syncVersionRetention: 0 });
    await service.push(user.id, 'connections', 'v1', 0);
    await service.push(user.id, 'connections', 'v2', 1);
    await service.push(user.id, 'connections', 'v3', 2);

    expect(syncRepo.historyVersions(user.id, 'connections')).toEqual([1, 2, 3]);
  });
});

describe('SyncService.pull', () => {
  it('returns a single section when one is named', async () => {
    const { service, user } = await setup();
    await service.push(user.id, 'connections', 'c1', 0);
    await service.push(user.id, 'queries', 'q1', 0);

    const res = await service.pull(user.id, 'connections');

    expect(res.sections).toHaveLength(1);
    expect(res.sections[0]).toMatchObject({ section: 'connections', encryptedData: 'c1', version: 1 });
    expect(res.sections[0].updateTime).toBeInstanceOf(Date);
  });

  it('returns every section when none is named', async () => {
    const { service, user } = await setup();
    await service.push(user.id, 'connections', 'c1', 0);
    await service.push(user.id, 'queries', 'q1', 0);
    await service.push(user.id, 'groups', 'g1', 0);

    const res = await service.pull(user.id);

    expect(res.sections.map((s) => s.section).sort()).toEqual(['connections', 'groups', 'queries']);
  });

  it('returns an empty list for a missing section instead of throwing', async () => {
    const { service, user } = await setup();
    await expect(service.pull(user.id, 'folders')).resolves.toEqual({ sections: [] });
    await expect(service.pull(4242)).resolves.toEqual({ sections: [] });
  });

  it('does not leak other users data', async () => {
    const { service, userRepo, user } = await setup();
    const other = await userRepo.create('b@example.com', 'scrypt$x$y', 'user', 'free');
    await service.push(user.id, 'connections', 'mine', 0);
    await service.push(other.id, 'connections', 'theirs', 0);

    expect((await service.pull(user.id)).sections[0].encryptedData).toBe('mine');
    expect((await service.pull(other.id)).sections[0].encryptedData).toBe('theirs');
  });
});

describe('SyncService.listVersions', () => {
  it('caps the list at the plan retention, newest first', async () => {
    const { service, user } = await setup({ syncVersionRetention: 2 });
    await service.push(user.id, 'connections', 'v1', 0);
    await service.push(user.id, 'connections', 'v2', 1);
    await service.push(user.id, 'connections', 'v3', 2);

    const versions = await service.listVersions(user.id, 'connections');
    expect(versions.map((v) => v.version)).toEqual([3, 2]);
    expect(versions[0].dataBytes).toBe(2);
    expect(versions[0].createTime).toBeInstanceOf(Date);
  });

  it('falls back to 100 when retention is 0, so the list is not empty', async () => {
    const { service, user } = await setup({ syncVersionRetention: 0 });
    await service.push(user.id, 'connections', 'v1', 0);
    await service.push(user.id, 'connections', 'v2', 1);

    expect((await service.listVersions(user.id, 'connections')).map((v) => v.version)).toEqual([2, 1]);
  });

  it('rejects an unknown user', async () => {
    const { service } = await setup();
    await expect(service.listVersions(4242, 'connections')).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
  });
});

describe('SyncService.rollback', () => {
  it('restores an old snapshot as a new version (current + 1)', async () => {
    const { service, syncRepo, user } = await setup();
    await service.push(user.id, 'connections', 'v1-data', 0);
    await service.push(user.id, 'connections', 'v2-data', 1);

    const res = await service.rollback(user.id, 'connections', 1);

    expect(res).toEqual({ version: 3 });
    const section = (await syncRepo.getSection(user.id, 'connections'))!;
    expect(section.encryptedData).toBe('v1-data');
    expect(section.version).toBe(3);
  });

  it('rejects a version that was never recorded', async () => {
    const { service, syncRepo, user } = await setup();
    await service.push(user.id, 'connections', 'v1', 0);

    const err = await service.rollback(user.id, 'connections', 9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionNotFoundError);
    expect((err as VersionNotFoundError).version).toBe(9);
    expect((await syncRepo.getSection(user.id, 'connections'))!.version).toBe(1);
  });

  it('rejects an unknown user', async () => {
    const { service } = await setup();
    await expect(service.rollback(4242, 'connections', 1)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
  });

  it('cannot be used to bypass the quota after a plan downgrade', async () => {
    const { service, syncRepo, plan, user } = await setup({ syncQuotaBytes: 1000 });
    await service.push(user.id, 'connections', 'a'.repeat(500), 0);
    await service.push(user.id, 'connections', 'b'.repeat(10), 1);

    plan.syncQuotaBytes = 100; // 降级到更小的配额

    const err = await service.rollback(user.id, 'connections', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).current).toBe(500);
    const section = (await syncRepo.getSection(user.id, 'connections'))!;
    expect(section.version).toBe(2);
    expect(section.encryptedData).toBe('b'.repeat(10));
  });

  it('prunes history after a rollback when retention applies', async () => {
    const { service, syncRepo, user } = await setup({ syncVersionRetention: 2 });
    await service.push(user.id, 'connections', 'v1', 0);
    await service.push(user.id, 'connections', 'v2', 1);
    await service.rollback(user.id, 'connections', 2);

    expect(syncRepo.historyVersions(user.id, 'connections')).toEqual([1, 2]);
  });
});
