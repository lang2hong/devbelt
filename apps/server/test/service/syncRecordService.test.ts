import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'crypto';
import {
  FakeSyncStateRepo, FakeSyncRecordRepo, FakeSyncNonceRepo, FakeSyncMutationRepo, FakePersonalSubscriptionRepo, FakePlanRepo,
} from '../helpers/fakeRepos.js';
import { SyncStateService } from '../../src/modules/db/service/syncStateService.js';
import { SyncRecordService } from '../../src/modules/db/service/syncRecordService.js';
import { jcs, requestDigestOf } from '../../src/modules/db/service/syncCrypto.js';
import {
  SyncVersionConflictError,
  SyncNonceReusedError,
  SyncQuotaExceededError,
  SyncEpochStaleError,
  SyncRecordNotFoundError,
  ConflictError,
  ValidationError,
} from '../../src/domain/errors.js';
import type { SmpKdf, RecoveryKdf, SyncEnvelope } from '../../src/domain/entities.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const runner = ((fn: any) => fn({} as Queryable));

function buf(n: number, fill = 1): Buffer { return Buffer.alloc(n, fill); }
function smpKdf(): SmpKdf { return { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: buf(16, 2), outputBytes: 32 }; }
function recoveryKdf(): RecoveryKdf { return { alg: 'hkdf-sha256', version: 1, salt: buf(16, 3), outputBytes: 32 }; }
function env(version: string, fill = 4): SyncEnvelope { return { version, nonce: buf(12, fill), ct: buf(32, fill + 1), tag: buf(16, fill + 2) }; }

function makeKeys() {
  const a = generateKeyPairSync('ed25519');
  return {
    signPriv: a.privateKey,
    signPub: Buffer.from((a.publicKey.export({ format: 'jwk' }) as any).x, 'base64url'),
  };
}

function mid(n: number): string { return Buffer.alloc(16, n).toString('base64url'); }
function rid(n: number): string { return Buffer.alloc(16, n).toString('base64url'); }

function signRecord(priv: KeyObject, userId: number, action: 'record.put' | 'record.delete', body: Record<string, unknown>) {
  const digest = requestDigestOf(body);
  const signingInput = {
    domain: 'dbclient/sync/v1', action, userId: String(userId),
    keyEpoch: body.keyEpoch, baseVersion: body.baseVersion, recordId: body.recordId,
    mutationId: body.mutationId, requestDigest: digest,
  };
  return { digest, signatureBuf: nodeSign(null, Buffer.from(jcs(signingInput), 'utf8'), priv) };
}

/** body 与签名一致：mutationId/recordId 必须与后续 service 调用完全一致。 */
function putBody(mutationId: string, recordId: string, nonceFill: number, ctFill: number, version: string, ciphertextLen = 100) {
  return {
    protocolVersion: 1, keyEpoch: '1', mutationId, recordId, baseVersion: version,
    cipherSuite: 'AES-256-GCM', formatVersion: 1,
    nonce: buf(12, nonceFill).toString('base64url'),
    ciphertext: buf(ciphertextLen, ctFill).toString('base64url'),
    tag: buf(16, 62).toString('base64url'),
  };
}

function decodeBody(body: Record<string, unknown>) {
  return {
    nonce: Buffer.from(body.nonce as string, 'base64url'),
    ciphertext: Buffer.from(body.ciphertext as string, 'base64url'),
    tag: Buffer.from(body.tag as string, 'base64url'),
  };
}

const USER = 42;
const RID = rid(1);

function makeStack() {
  const stateRepo = new FakeSyncStateRepo();
  const recordRepo = new FakeSyncRecordRepo();
  const mutationRepo = new FakeSyncMutationRepo();
  const nonceRepo = new FakeSyncNonceRepo();
  const subscriptionRepo = new FakePersonalSubscriptionRepo();
  const planRepo = new FakePlanRepo();
  const stateSvc = new SyncStateService(stateRepo, recordRepo, mutationRepo, runner);
  const recordSvc = new SyncRecordService(stateRepo, recordRepo, nonceRepo, mutationRepo, subscriptionRepo, planRepo, runner);
  return { stateSvc, recordSvc, stateRepo, recordRepo, nonceRepo, mutationRepo, subscriptionRepo, planRepo };
}

async function init(stack: ReturnType<typeof makeStack>) {
  const keys = makeKeys();
  await stack.stateSvc.init(USER, {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    smpKdf: smpKdf(), recoveryKdf: recoveryKdf(), envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1'), accountRecoveryKey: buf(32, 99),
    signPub: keys.signPub, recoverSignPub: keys.signPub,
  });
  return keys;
}

async function createRecord(keys: ReturnType<typeof makeKeys>, stack: ReturnType<typeof makeStack>, m: number, r: number) {
  const mMid = mid(m);
  const rId = rid(r);
  const body = putBody(mMid, rId, 50 + m, 51 + m, '0');
  const s = signRecord(keys.signPriv, USER, 'record.put', body);
  return stack.recordSvc.putRecord(USER, {
    keyEpoch: '1', mutationId: mMid, signature: s.signatureBuf, baseVersion: '0', requestDigest: s.digest,
    recordId: rId, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(body),
  });
}

describe('SyncRecordService', () => {
  it('rejects a non-canonical recordId (padded / aliased base64url)', async () => {
    const stack = makeStack();
    const keys = await init(stack);
    const mMid = mid(77);
    const badId = `${RID}=`;
    const body = putBody(mMid, badId, 70, 71, '0');
    const s = signRecord(keys.signPriv, USER, 'record.put', body);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: mMid, signature: s.signatureBuf, baseVersion: '0', requestDigest: s.digest,
      recordId: badId, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(body),
    })).rejects.toThrow(/base64url/i);
  });

  it('creates, pulls, updates optimistically, and deletes (tombstone)', async () => {
    const stack = makeStack();
    const keys = await init(stack);

    const createMid = mid(9);
    const createBody = putBody(createMid, RID, 60, 61, '0');
    const create = signRecord(keys.signPriv, USER, 'record.put', createBody);
    const created = await stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: createMid, signature: create.signatureBuf, baseVersion: '0', requestDigest: create.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(createBody),
    });
    expect(created).toEqual({ version: '1', changeSequence: '1' });

    const pull = await stack.recordSvc.pull(USER, '0', undefined, 256);
    expect(pull.records).toHaveLength(1);
    expect(pull.records[0].recordId).toBe(RID);
    expect(pull.records[0].version).toBe('1');
    expect(pull.snapshotSequence).toBe('1');

    const updMid = mid(8);
    const updateBody = putBody(updMid, RID, 63, 64, '1', 200);
    const update = signRecord(keys.signPriv, USER, 'record.put', updateBody);
    const updated = await stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: updMid, signature: update.signatureBuf, baseVersion: '1', requestDigest: update.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(updateBody),
    });
    expect(updated.version).toBe('2');

    const staleMid = mid(7);
    const staleBody = putBody(staleMid, RID, 66, 67, '1', 50);
    const stale = signRecord(keys.signPriv, USER, 'record.put', staleBody);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: staleMid, signature: stale.signatureBuf, baseVersion: '1', requestDigest: stale.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(staleBody),
    })).rejects.toBeInstanceOf(SyncVersionConflictError);

    const delMid = mid(6);
    const delBody = { protocolVersion: 1, keyEpoch: '1', mutationId: delMid, recordId: RID, baseVersion: '2' };
    const delSign = signRecord(keys.signPriv, USER, 'record.delete', delBody);
    const deleted = await stack.recordSvc.deleteRecord(USER, {
      keyEpoch: '1', mutationId: delMid, signature: delSign.signatureBuf, baseVersion: '2', requestDigest: delSign.digest,
      recordId: RID,
    });
    expect(deleted.version).toBe('3');

    const pullAfter = await stack.recordSvc.pull(USER, '0', undefined, 256);
    expect(pullAfter.records[0].deleteTime).not.toBeNull();
  });

  it('rejects nonce reuse (ledger)', async () => {
    const stack = makeStack();
    const keys = await init(stack);

    const m1 = mid(5);
    const body1 = putBody(m1, RID, 60, 61, '0');
    const s1 = signRecord(keys.signPriv, USER, 'record.put', body1);
    await stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m1, signature: s1.signatureBuf, baseVersion: '0', requestDigest: s1.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(body1),
    });

    const m2 = mid(4);
    const body2 = putBody(m2, RID, 60, 63, '1', 100); // 复用同一 nonce fill=60
    const s2 = signRecord(keys.signPriv, USER, 'record.put', body2);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m2, signature: s2.signatureBuf, baseVersion: '1', requestDigest: s2.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(body2),
    })).rejects.toBeInstanceOf(SyncNonceReusedError);
  });

  it('enforces count quota', async () => {
    const stack = makeStack();
    const keys = await init(stack);
    const free = await stack.planRepo.findByCode('free');
    free!.features = { ...free!.features, maxConnectionMetas: 1, syncStorageBytes: 33554432 };
    await stack.subscriptionRepo.create({
      userId: USER, planId: free!.id, status: 'active',
      periodStartTime: new Date(), periodEndTime: null,
    });

    const m1 = mid(3);
    const b1 = putBody(m1, RID, 70, 71, '0');
    const s1 = signRecord(keys.signPriv, USER, 'record.put', b1);
    await stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m1, signature: s1.signatureBuf, baseVersion: '0', requestDigest: s1.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(b1),
    });

    const m2 = mid(2);
    const rid2 = rid(2);
    const b2 = putBody(m2, rid2, 73, 74, '0');
    const s2 = signRecord(keys.signPriv, USER, 'record.put', b2);
    try {
      await stack.recordSvc.putRecord(USER, {
        keyEpoch: '1', mutationId: m2, signature: s2.signatureBuf, baseVersion: '0', requestDigest: s2.digest,
        recordId: rid2, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(b2),
      });
    } catch (e: any) {
      expect(e).toBeInstanceOf(SyncQuotaExceededError);
      expect(e.quota).toBe('count');
      expect(e.limit).toBe('1');
      expect(e.used).toBe('1');
      return;
    }
    throw new Error('expected SYNC_QUOTA_EXCEEDED');
  });

  it('expired subscription falls back to free quota instead of unlimited (P0 regression)', async () => {
    const stack = makeStack();
    const keys = await init(stack);
    // free 限额 1；pro 限额高。订阅挂在 pro 但已到期 → 派生应回 free（1），而非 0/unlimited。
    const free = await stack.planRepo.findByCode('free');
    free!.features = { ...free!.features, maxConnectionMetas: 1 };
    const pro = await stack.planRepo.findByCode('pro');
    await stack.subscriptionRepo.create({
      userId: USER, planId: pro!.id, status: 'active',
      periodStartTime: new Date(Date.now() - 60_000), periodEndTime: new Date(Date.now() - 1000),
    });

    const m1 = mid(3);
    const b1 = putBody(m1, RID, 70, 71, '0');
    const s1 = signRecord(keys.signPriv, USER, 'record.put', b1);
    await stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m1, signature: s1.signatureBuf, baseVersion: '0', requestDigest: s1.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(b1),
    });

    const m2 = mid(2);
    const rid2 = rid(2);
    const b2 = putBody(m2, rid2, 73, 74, '0');
    const s2 = signRecord(keys.signPriv, USER, 'record.put', b2);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m2, signature: s2.signatureBuf, baseVersion: '0', requestDigest: s2.digest,
      recordId: rid2, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(b2),
    })).rejects.toBeInstanceOf(SyncQuotaExceededError);
  });

  it('rejects stale epoch and enforces idempotent-replay semantics', async () => {
    const stack = makeStack();
    const keys = await init(stack);

    // stale epoch
    const staleMid = mid(11);
    const staleBody = { ...putBody(staleMid, RID, 80, 81, '0'), keyEpoch: '2' };
    const stale = signRecord(keys.signPriv, USER, 'record.put', staleBody);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '2', mutationId: staleMid, signature: stale.signatureBuf, baseVersion: '0', requestDigest: stale.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(staleBody),
    })).rejects.toBeInstanceOf(SyncEpochStaleError);

    // create + idempotent replay
    const m = mid(12);
    const body = putBody(m, RID, 83, 84, '0');
    const s = signRecord(keys.signPriv, USER, 'record.put', body);
    const input = {
      keyEpoch: '1', mutationId: m, signature: s.signatureBuf, baseVersion: '0', requestDigest: s.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, ...decodeBody(body),
    };
    const r1 = await stack.recordSvc.putRecord(USER, input);
    const r2 = await stack.recordSvc.putRecord(USER, input);
    expect(r1.version).toBe('1');
    expect(r2.version).toBe('1');

    // same mutationId + different digest → 409 CONFLICT
    const body2 = putBody(m, RID, 83, 86, '0', 90);
    const s2 = signRecord(keys.signPriv, USER, 'record.put', body2);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m, signature: s2.signatureBuf, baseVersion: '0', requestDigest: s2.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(body2),
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects create on existing record (active / tombstone) and expired-receipt replay', async () => {
    const stack = makeStack();
    const keys = await init(stack);

    // 1) active 记录复用 create → SYNC_VERSION_CONFLICT{currentVersion}
    const m1 = mid(20);
    const b1 = putBody(m1, RID, 60, 61, '0');
    const s1 = signRecord(keys.signPriv, USER, 'record.put', b1);
    await stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m1, signature: s1.signatureBuf, baseVersion: '0', requestDigest: s1.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(b1),
    });

    const m2 = mid(21);
    const b2 = putBody(m2, RID, 64, 65, '0');
    const s2 = signRecord(keys.signPriv, USER, 'record.put', b2);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m2, signature: s2.signatureBuf, baseVersion: '0', requestDigest: s2.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(b2),
    })).rejects.toMatchObject({ name: 'SyncVersionConflictError', code: 'SYNC_VERSION_CONFLICT', currentVersion: '1' });

    // 2) tombstone 记录复用 create → SYNC_VERSION_CONFLICT{currentVersion}（不再落 INSERT 撞唯一键 500）
    const m3 = mid(22);
    const dB = { protocolVersion: 1, keyEpoch: '1', mutationId: m3, recordId: RID, baseVersion: '1' };
    const dS = signRecord(keys.signPriv, USER, 'record.delete', dB);
    await stack.recordSvc.deleteRecord(USER, {
      keyEpoch: '1', mutationId: m3, signature: dS.signatureBuf, baseVersion: '1', requestDigest: dS.digest, recordId: RID,
    });

    const m4 = mid(23);
    const b4 = putBody(m4, RID, 66, 67, '0');
    const s4 = signRecord(keys.signPriv, USER, 'record.put', b4);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m4, signature: s4.signatureBuf, baseVersion: '0', requestDigest: s4.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(b4),
    })).rejects.toMatchObject({ name: 'SyncVersionConflictError', code: 'SYNC_VERSION_CONFLICT', currentVersion: '2' });

    // 3) 过期 receipt 后的字节级重放 → nonce ledger 兜底拒绝（§7.4「绝不绕过 nonce 校验」）
    for (const r of stack.mutationRepo.store.values()) r.expiresTime = new Date(Date.now() - 1000);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: m1, signature: s1.signatureBuf, baseVersion: '0', requestDigest: s1.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(b1),
    })).rejects.toBeInstanceOf(SyncNonceReusedError);
  });

  it('update/delete on tombstone → SYNC_VERSION_CONFLICT; nonexistent → NOT_FOUND without recordId', async () => {
    const stack = makeStack();
    const keys = await init(stack);

    // create RID (version 1) then tombstone → version 2
    const createMid = mid(30);
    const createBody = putBody(createMid, RID, 60, 61, '0');
    const create = signRecord(keys.signPriv, USER, 'record.put', createBody);
    await stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: createMid, signature: create.signatureBuf, baseVersion: '0', requestDigest: create.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(createBody),
    });
    const delMid = mid(31);
    const delBody = { protocolVersion: 1, keyEpoch: '1', mutationId: delMid, recordId: RID, baseVersion: '1' };
    const delSign = signRecord(keys.signPriv, USER, 'record.delete', delBody);
    await stack.recordSvc.deleteRecord(USER, {
      keyEpoch: '1', mutationId: delMid, signature: delSign.signatureBuf, baseVersion: '1', requestDigest: delSign.digest, recordId: RID,
    });

    // update (baseVersion '1') on tombstone → currentVersion=tombstone '2'
    const updMid = mid(32);
    const updBody = putBody(updMid, RID, 70, 71, '1');
    const updSign = signRecord(keys.signPriv, USER, 'record.put', updBody);
    await expect(stack.recordSvc.putRecord(USER, {
      keyEpoch: '1', mutationId: updMid, signature: updSign.signatureBuf, baseVersion: '1', requestDigest: updSign.digest,
      recordId: RID, cipherSuite: 'AES-256-GCM', formatVersion: 1, ...decodeBody(updBody),
    })).rejects.toMatchObject({ name: 'SyncVersionConflictError', code: 'SYNC_VERSION_CONFLICT', currentVersion: '2' });

    // delete with baseVersion 恰等于 tombstone 版本 → 仍 409（不落入 softDelete 的成功分支）
    const delMid2 = mid(33);
    const dB2 = { protocolVersion: 1, keyEpoch: '1', mutationId: delMid2, recordId: RID, baseVersion: '2' };
    const dS2 = signRecord(keys.signPriv, USER, 'record.delete', dB2);
    await expect(stack.recordSvc.deleteRecord(USER, {
      keyEpoch: '1', mutationId: delMid2, signature: dS2.signatureBuf, baseVersion: '2', requestDigest: dS2.digest, recordId: RID,
    })).rejects.toMatchObject({ name: 'SyncVersionConflictError', code: 'SYNC_VERSION_CONFLICT', currentVersion: '2' });

    // 真不存在 → NOT_FOUND，message 不含 recordId
    const ghostId = rid(99);
    const gm = mid(34);
    const gBody = { protocolVersion: 1, keyEpoch: '1', mutationId: gm, recordId: ghostId, baseVersion: '1' };
    const gSign = signRecord(keys.signPriv, USER, 'record.delete', gBody);
    const ghostErr = await stack.recordSvc.deleteRecord(USER, {
      keyEpoch: '1', mutationId: gm, signature: gSign.signatureBuf, baseVersion: '1', requestDigest: gSign.digest, recordId: ghostId,
    }).catch((e) => e);
    expect(ghostErr).toBeInstanceOf(SyncRecordNotFoundError);
    expect((ghostErr as any).message).toBe('record not found');
    expect((ghostErr as any).code).toBe('NOT_FOUND');
  });

  it('validates cursor/snapshot range (future snapshot, after > snapshot)', async () => {
    const stack = makeStack();
    const keys = await init(stack);
    await createRecord(keys, stack, 40, 40);
    await createRecord(keys, stack, 41, 41);
    await createRecord(keys, stack, 42, 42); // changeSequence = 3

    // future snapshot
    await expect(stack.recordSvc.pull(USER, '0', '100', 256)).rejects.toBeInstanceOf(ValidationError);

    // after > snapshotSequence
    await expect(stack.recordSvc.pull(USER, '4', '3', 256)).rejects.toBeInstanceOf(ValidationError);

    // 边界：after == snapshotSequence → 空页（合法，客户端已追上）
    const p = await stack.recordSvc.pull(USER, '3', '3', 256);
    expect(p.records).toHaveLength(0);
    expect(p.snapshotSequence).toBe('3');
  });

  it('serves a fixed snapshot across pages (later writes excluded)', async () => {
    const stack = makeStack();
    const keys = await init(stack);
    await createRecord(keys, stack, 50, 50); // seq 1
    await createRecord(keys, stack, 51, 51); // seq 2
    await createRecord(keys, stack, 52, 52); // seq 3

    const snap = '3';
    const p1 = await stack.recordSvc.pull(USER, '0', snap, 2);
    expect(p1.snapshotSequence).toBe(snap);
    expect(p1.records.map((x) => x.changeSequence)).toEqual(['1', '2']);
    expect(p1.nextAfter).toBe('2');

    // 快照之后的新写入（seq 4）不得混入下一页
    await createRecord(keys, stack, 53, 53); // seq 4

    const p2 = await stack.recordSvc.pull(USER, '2', snap, 2);
    expect(p2.snapshotSequence).toBe(snap);
    expect(p2.records.map((x) => x.changeSequence)).toEqual(['3']);
    expect(p2.nextAfter).toBeUndefined();
  });
});