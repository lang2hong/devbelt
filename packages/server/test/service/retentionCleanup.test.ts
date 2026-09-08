import { describe, it, expect } from 'vitest';
import {
  FakeRefreshTokenRepo,
  FakeEmailVerificationTokenRepo,
  FakeSyncMutationRepo,
  FakeSyncResetTokenRepo,
} from '../helpers/fakeRepos.js';
import { FakeMailFlowRepo } from '../helpers/linkFlowFakes.js';
import { startRetentionCleanup } from '../../src/service/retentionCleanup.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const exec = () => ({} as Queryable);
const HOUR = 3600_000;
const DAY = 86_400_000;

function makeDeps() {
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const emailVerificationTokenRepo = new FakeEmailVerificationTokenRepo();
  const syncMutationRepo = new FakeSyncMutationRepo();
  const syncResetTokenRepo = new FakeSyncResetTokenRepo();
  const mailFlowRepo = new FakeMailFlowRepo();
  return { refreshTokenRepo, emailVerificationTokenRepo, syncMutationRepo, syncResetTokenRepo, mailFlowRepo, exec };
}

describe('retention cleanup', () => {
  it('removes expired refresh tokens but keeps live ones', async () => {
    const deps = makeDeps();
    const now = Date.now();
    // 已过期很久
    await deps.refreshTokenRepo.create(exec(), {
      userId: 1, deviceId: null, tokenHash: 'old', familyId: 'f1',
      replacedByTokenId: null, expiresTime: new Date(now - 30 * DAY),
    });
    // 仍然有效 —— 绝不能被删
    await deps.refreshTokenRepo.create(exec(), {
      userId: 1, deviceId: null, tokenHash: 'live', familyId: 'f2',
      replacedByTokenId: null, expiresTime: new Date(now + 30 * DAY),
    });

    const c = startRetentionCleanup(deps, {});
    await c.runOnce();
    c.stop();

    expect(await deps.refreshTokenRepo.findByHash('old')).toBeUndefined();
    expect(await deps.refreshTokenRepo.findByHash('live')).toBeDefined();
  });

  it('keeps a recently revoked refresh token until its retention window passes', async () => {
    const deps = makeDeps();
    const now = Date.now();
    const t = await deps.refreshTokenRepo.create(exec(), {
      userId: 1, deviceId: null, tokenHash: 'justRevoked', familyId: 'f1',
      replacedByTokenId: null, expiresTime: new Date(now + 30 * DAY),
    });
    await deps.refreshTokenRepo.consume(exec(), t.id, new Date(now - HOUR));

    const c = startRetentionCleanup(deps, {});
    await c.runOnce();
    c.stop();

    // 默认保留 7 天：1 小时前撤销的仍应保留，便于排查「为什么被登出」。
    expect(await deps.refreshTokenRepo.findByHash('justRevoked')).toBeDefined();

    // 把保留期压到 0 后应被清掉。
    const c2 = startRetentionCleanup(deps, { refreshTokenRetentionMs: 0 });
    await c2.runOnce();
    c2.stop();
    expect(await deps.refreshTokenRepo.findByHash('justRevoked')).toBeUndefined();
  });

  it('prunes expired sync mutation receipts (the expires_time column nobody consumed)', async () => {
    const deps = makeDeps();
    const now = Date.now();
    const base = { userId: 1, keyEpoch: '1', requestDigest: Buffer.alloc(32, 1), action: 'record.put' as const, resultVersion: '1', resultChangeSequence: '1', status: 'applied' as const };
    await deps.syncMutationRepo.record(exec(), { ...base, mutationId: Buffer.alloc(16, 1), expiresTime: new Date(now - HOUR) });
    await deps.syncMutationRepo.record(exec(), { ...base, mutationId: Buffer.alloc(16, 2), expiresTime: new Date(now + HOUR) });

    const c = startRetentionCleanup(deps, {});
    await c.runOnce();
    c.stop();

    expect(await deps.syncMutationRepo.findByMutationId(exec(), 1, '1', Buffer.alloc(16, 1))).toBeUndefined();
    // 未过期的 receipt 必须留着，否则幂等重放会退化成重复执行
    expect(await deps.syncMutationRepo.findByMutationId(exec(), 1, '1', Buffer.alloc(16, 2))).toBeDefined();
  });

  it('prunes expired and consumed mail flows beyond retention, keeps live ones', async () => {
    const deps = makeDeps();
    const now = Date.now();
    const expired = await deps.mailFlowRepo.create({
      type: 'verify-email',
      targetTokenHash: Buffer.alloc(32, 1),
      targetRecordId: null,
      userId: null,
      nonceHash: Buffer.alloc(32, 1),
      expiresTime: new Date(now - 2 * DAY),
    });
    await deps.mailFlowRepo.markConsumed(exec(), expired.id, new Date(now - 2 * DAY));
    await deps.mailFlowRepo.create({
      type: 'verify-email',
      targetTokenHash: Buffer.alloc(32, 2),
      targetRecordId: null,
      userId: null,
      nonceHash: Buffer.alloc(32, 2),
      expiresTime: new Date(now + HOUR),
    });

    const c = startRetentionCleanup(deps, {});
    await c.runOnce();
    c.stop();

    // 已消费且超出保留期 → 删；仍在有效期（未消费、未过期）→ 留。
    expect(deps.mailFlowRepo.store.size).toBe(1);
  });

  it('honours batchSize so a single round cannot hold locks unboundedly', async () => {
    const deps = makeDeps();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await deps.refreshTokenRepo.create(exec(), {
        userId: 1, deviceId: null, tokenHash: `t${i}`, familyId: 'f',
        replacedByTokenId: null, expiresTime: new Date(now - 30 * DAY),
      });
    }
    const c = startRetentionCleanup(deps, { batchSize: 2 });
    await c.runOnce();
    c.stop();
    // 一轮只删 2 条，剩 3 条留给后续周期
    expect(deps.refreshTokenRepo.store.size).toBe(3);
  });

  it('one table failing does not stop the others', async () => {
    const deps = makeDeps();
    const now = Date.now();
    await deps.refreshTokenRepo.create(exec(), {
      userId: 1, deviceId: null, tokenHash: 'old', familyId: 'f',
      replacedByTokenId: null, expiresTime: new Date(now - 30 * DAY),
    });
    // 让第一张表抛错
    deps.emailVerificationTokenRepo.prune = async () => { throw new Error('boom'); };

    const c = startRetentionCleanup(deps, {});
    await expect(c.runOnce()).resolves.toBeUndefined();
    c.stop();

    expect(await deps.refreshTokenRepo.findByHash('old')).toBeUndefined();
  });

  it('does not fire immediately on start (no startup thundering herd)', async () => {
    const deps = makeDeps();
    const now = Date.now();
    await deps.refreshTokenRepo.create(exec(), {
      userId: 1, deviceId: null, tokenHash: 'old', familyId: 'f',
      replacedByTokenId: null, expiresTime: new Date(now - 30 * DAY),
    });
    const c = startRetentionCleanup(deps, { intervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    c.stop();
    // 首次触发在 +intervalMs，启动瞬间不应有删除
    expect(await deps.refreshTokenRepo.findByHash('old')).toBeDefined();
  });
});
