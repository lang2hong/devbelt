import { describe, it, expect } from 'vitest';
import { IdempotencyService, canonicalJson, validateIdempotencyKey } from '../../src/service/idempotencyService.js';
import { FakeIdempotencyReceiptRepo } from '../helpers/fakeRepos.js';
import type { Queryable, TxRunner } from '../../src/repository/mysql/db.js';

const UUID_V4 = '123e4567-e89b-42d3-8456-426614174000';

function key() {
  return { actorUserId: 1, sessionId: 's1', method: 'PATCH', normalizedPath: '/api/console/me', idempotencyKey: UUID_V4 };
}

/** 模拟事务：失败时把内存 store 回滚到快照（等价于 withTransaction 的 ROLLBACK）。 */
function rollbackRunner(repo: FakeIdempotencyReceiptRepo): TxRunner {
  return async (fn) => {
    const snapshot = new Map(repo.store);
    try {
      return await fn({} as Queryable);
    } catch (e) {
      repo.store.clear();
      for (const [k, v] of snapshot) repo.store.set(k, v);
      throw e;
    }
  };
}

function makeService(repo = new FakeIdempotencyReceiptRepo(), maxWaitMs = 0) {
  return new IdempotencyService(repo, rollbackRunner(repo), maxWaitMs);
}

describe('IdempotencyService.run', () => {
  it('first request executes business; same-key same-digest replays without re-running business', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    const svc = makeService(repo);
    let runs = 0;
    const input = {
      ...key(),
      requestBody: { a: 1, b: [true, null] },
      business: async () => { runs += 1; return { status: 200, body: { ok: true } }; },
    };

    const first = await svc.run(input);
    expect(first.replayed).toBe(false);
    expect(first.body).toEqual({ ok: true });

    const second = await svc.run(input);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true });
    expect(runs).toBe(1);
  });

  it('replays an empty persisted body as null instead of throwing', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    const svc = makeService(repo);
    // 业务返回 undefined body 时 complete 存的是空串（canonicalJson(undefined)）；
    // 重放必须把它还原为 null，而不是 JSON.parse('') 抛错。
    const input = {
      ...key(),
      requestBody: { a: 1 },
      business: async () => ({ status: 204, body: undefined as unknown }),
    };

    const first = await svc.run(input);
    expect(first.replayed).toBe(false);
    expect(first.body).toBeUndefined();

    const second = await svc.run(input);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(204);
    expect(second.body).toBeNull();
  });

  it('same key with a different digest throws IDEMPOTENCY_KEY_REUSED', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    const svc = makeService(repo);
    await svc.run({ ...key(), requestBody: { a: 1 }, business: async () => ({ status: 200, body: {} }) });
    await expect(
      svc.run({ ...key(), requestBody: { a: 2 }, business: async () => ({ status: 200, body: {} }) }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rolls back on business failure so the receipt does not persist', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    const svc = makeService(repo);
    await expect(
      svc.run({ ...key(), requestBody: { a: 1 }, business: async () => { throw new Error('boom'); } }),
    ).rejects.toThrow('boom');
    expect(repo.store.size).toBe(0);
  });

  it('beforeWrite (rate limit) failure rolls back the receipt; same key is re-submittable', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    const svc = makeService(repo);
    let calls = 0;
    const input = {
      ...key(),
      requestBody: { a: 1 },
      beforeWrite: async () => { calls += 1; if (calls === 1) throw new Error('throttled'); },
      business: async () => ({ status: 200, body: {} }),
    };
    await expect(svc.run(input)).rejects.toThrow('throttled');
    expect(repo.store.size).toBe(0);

    const retry = await svc.run(input);
    expect(retry.replayed).toBe(false);
    expect(calls).toBe(2);
    expect(repo.store.size).toBe(1);
  });

  it('complete failure rolls back the entire transaction, leaving no residual receipt', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    (repo as any).complete = async () => { throw new Error('complete fail'); };
    const svc = makeService(repo);
    await expect(
      svc.run({ ...key(), requestBody: { a: 1 }, business: async () => ({ status: 200, body: {} }) }),
    ).rejects.toThrow('complete fail');
    expect(repo.store.size).toBe(0);
  });

  it('applies a custom retention window (e.g. admin write 30d) to the receipt expiry', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    const svc = makeService(repo);
    await svc.run({
      ...key(), requestBody: { a: 1 }, retentionMs: 30 * 86_400_000,
      business: async () => ({ status: 200, body: {} }),
    });
    const receipt = await repo.findByKey(1, 's1', 'PATCH', '/api/console/me', UUID_V4);
    expect(receipt).toBeDefined();
    expect(receipt!.expiresTime.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
  });

  it('throws IDEMPOTENCY_IN_PROGRESS while a processing receipt has not resolved', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    const svc = makeService(repo, 0);
    // 预置一条 processing 回执（模拟并发处理中），摘要与本请求一致 → 允许等待后超时。
    const { createHash } = await import('crypto');
    const digest = createHash('sha256').update(canonicalJson({ a: 1 })).digest();
    await repo.createProcessing({} as Queryable, {
      ...key(),
      requestDigest: digest,
      expiresTime: new Date(Date.now() + 3600_000),
    });
    await expect(
      svc.run({ ...key(), requestBody: { a: 1 }, business: async () => ({ status: 200, body: {} }) }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
  });

  it('immediately rejects a different digest while a processing receipt exists', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    const svc = makeService(repo, 0);
    // 预置 processing 回执，摘要不同于本次请求（摘要不匹配 → 立即 KEY_REUSED，而非 in-progress）。
    await repo.createProcessing({} as Queryable, {
      ...key(),
      requestDigest: Buffer.alloc(32, 0xab),
      expiresTime: new Date(Date.now() + 3600_000),
    });
    await expect(
      svc.run({ ...key(), requestBody: { a: 1 }, business: async () => ({ status: 200, body: {} }) }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('concurrent same-key requests: only the winner runs beforeWrite, the loser replays', async () => {
    const repo = new FakeIdempotencyReceiptRepo();
    const plainRunner: TxRunner = async (fn) => fn({} as Queryable);
    const svc = new IdempotencyService(repo, plainRunner, 5000, async () => {});
    let beforeWriteCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const input = {
      ...key(),
      requestBody: { a: 1 },
      beforeWrite: async () => { beforeWriteCalls += 1; },
      business: async () => { await gate; return { status: 200, body: { ok: true } }; },
    };

    const p1 = svc.run(input);
    // 等首个请求抢占到 processing 回执（唯一键提交），再发起同 key 请求。
    await waitFor(() => repo.store.size === 1);
    const p2 = svc.run(input);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(true);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ ok: true });
    // 并发败者不执行 beforeWrite（不重复限流、不 429）。
    expect(beforeWriteCalls).toBe(1);
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('canonicalJson', () => {
  it('normalizes object key order for stable digests', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('serializes nested structures and empty input deterministically', () => {
    expect(canonicalJson({ x: [3, { z: 1, y: 2 }] })).toBe('{"x":[3,{"y":2,"z":1}]}');
    expect(canonicalJson(undefined)).toBe('');
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('validateIdempotencyKey', () => {
  it('accepts a canonical UUIDv4', () => {
    expect(validateIdempotencyKey(UUID_V4)).toBe(UUID_V4);
  });

  it('rejects missing, repeated-char, wrong-version and multi-value keys', () => {
    expect(() => validateIdempotencyKey(undefined)).toThrow(/UUIDv4/);
    expect(() => validateIdempotencyKey('k'.repeat(22))).toThrow(/UUIDv4/);
    expect(() => validateIdempotencyKey('123e4567-e89b-12d3-8456-426614174000')).toThrow(/UUIDv4/);
    expect(() => validateIdempotencyKey([UUID_V4, UUID_V4])).toThrow(/UUIDv4/);
  });
});