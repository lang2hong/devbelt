import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'crypto';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';
import { MysqlSyncStateRepo } from '../../src/repository/mysql/syncStateRepo.js';
import { MysqlSyncRecordRepo } from '../../src/repository/mysql/syncRecordRepo.js';
import { MysqlSyncNonceRepo } from '../../src/repository/mysql/syncNonceRepo.js';
import { MysqlSyncMutationRepo } from '../../src/repository/mysql/syncMutationRepo.js';
import { MysqlPersonalSubscriptionRepo } from '../../src/repository/mysql/personalSubscriptionRepo.js';
import { SyncStateService } from '../../src/service/syncStateService.js';
import { SyncRecordService } from '../../src/service/syncRecordService.js';
import { jcs } from '../../src/service/syncCrypto.js';
import type { PersonalSyncState } from '../../src/domain/entities.js';
import type { SyncNewState } from '../../src/service/syncStateService.js';

const URL = process.env.MYSQL_TEST_URL;

function buf(n: number, fill = 1): Buffer { return Buffer.alloc(n, fill); }

function makeKeys() {
  const a = generateKeyPairSync('ed25519');
  const b = generateKeyPairSync('ed25519');
  return {
    signPriv: a.privateKey,
    recoverPriv: b.privateKey,
    signPub: Buffer.from((a.publicKey.export({ format: 'jwk' }) as any).x, 'base64url'),
    recoverPub: Buffer.from((b.publicKey.export({ format: 'jwk' }) as any).x, 'base64url'),
  };
}

function makeState(userId: number, keys: ReturnType<typeof makeKeys>): PersonalSyncState {
  return {
    userId, keyEpoch: '1', stateVersion: '1', changeSequence: '0',
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: buf(16, 2), outputBytes: 32 },
    recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: buf(16, 3), outputBytes: 32 },
    envelopeSmp: { version: '1', nonce: buf(12, 4), ct: buf(32, 5), tag: buf(16, 6) },
    envelopeRecovery: { version: '1', nonce: buf(12, 7), ct: buf(32, 8), tag: buf(16, 9) },
    envelopeAccount: { version: '1', nonce: buf(12, 10), ct: buf(32, 11), tag: buf(16, 12) },
    accountRecoveryKey: buf(32, 13),
    signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    recoveryCodeSetTime: null, createTime: new Date(), updateTime: new Date(),
  };
}

/**
 * destroy 用的新 state。salt/nonce 全部随 `fill` 变化：服务端要求重写 envelope 时
 * KDF salt 与 GCM nonce 都必须换新（同 salt ⇒ 同 KEK，同 nonce ⇒ 同密钥流，
 * 而 envelope 密文只有 32 字节，两条即可异或出主密钥）。
 * 原先这里的 salt 写死为 makeState 的同一批填充值，会被该校验拒掉。
 */
function newState(fill = 20): SyncNewState {
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: buf(16, fill + 8), outputBytes: 32 },
    recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: buf(16, fill + 9), outputBytes: 32 },
    envelopeSmp: { version: '1', nonce: buf(12, fill), ct: buf(32, fill + 1), tag: buf(16, fill + 2) },
    envelopeRecovery: { version: '1', nonce: buf(12, fill + 3), ct: buf(32, fill + 4), tag: buf(16, fill + 5) },
    envelopeAccount: { version: '1', nonce: buf(12, fill + 8), ct: buf(32, fill + 9), tag: buf(16, fill + 10) },
    accountRecoveryKey: buf(32, fill + 11),
    signPub: buf(32, fill + 6), recoverSignPub: buf(32, fill + 7),
  };
}

function signRecord(priv: KeyObject, userId: number, action: string, body: { keyEpoch: string; baseVersion: string; recordId: string; mutationId: string; requestDigest: string }): Buffer {
  const signingInput = {
    domain: 'dbclient/sync/v1', action, userId: String(userId),
    keyEpoch: body.keyEpoch, baseVersion: body.baseVersion, recordId: body.recordId,
    mutationId: body.mutationId, requestDigest: body.requestDigest,
  };
  return nodeSign(null, Buffer.from(jcs(signingInput), 'utf8'), priv);
}

function signState(priv: KeyObject, userId: number, action: string, body: { keyEpoch: string; expectedStateVersion: string; mutationId: string; requestDigest: string }): Buffer {
  const signingInput = {
    domain: 'dbclient/sync/v1', action, userId: String(userId),
    keyEpoch: body.keyEpoch, expectedStateVersion: body.expectedStateVersion,
    mutationId: body.mutationId, requestDigest: body.requestDigest,
  };
  return nodeSign(null, Buffer.from(jcs(signingInput), 'utf8'), priv);
}

async function makeUser(db: MysqlDb, email: string): Promise<number> {
  const [r] = await db.query<any>(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES (?, 'hash', NULL, 'active')",
    [email],
  );
  return Number(r.insertId);
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

describe.skipIf(!URL)('sync concurrency (real MySQL)', () => {
  let pool: mysql.Pool;
  let db: MysqlDb;

  beforeAll(async () => {
    pool = createTestPool();
    db = pool as unknown as MysqlDb;
    await runMigrations(db, [...migrations]);
  });

  afterAll(async () => { await pool.end(); });

  function recordSvc() {
    return new SyncRecordService(
      new MysqlSyncStateRepo(() => db),
      new MysqlSyncRecordRepo(),
      new MysqlSyncNonceRepo(),
      new MysqlSyncMutationRepo(),
      new MysqlPersonalSubscriptionRepo(() => db),
      (fn) => withTransaction(db, fn),
    );
  }

  function stateSvc() {
    return new SyncStateService(
      new MysqlSyncStateRepo(() => db),
      new MysqlSyncRecordRepo(),
      new MysqlSyncMutationRepo(),
      (fn) => withTransaction(db, fn),
    );
  }

  it('concurrent create of the same recordId yields exactly one winner (version conflict)', async () => {
    const userId = await makeUser(db, uniqueEmail('scc-put'));
    const keys = makeKeys();
    const stateRepo = new MysqlSyncStateRepo(() => db);
    await withTransaction(db, (tx) => stateRepo.create(tx, makeState(userId, keys)));

    const svc = recordSvc();
    const recordId = buf(16, 70).toString('base64url');
    const build = (mutationIdFill: number, nonceFill: number) => {
      const mutationId = buf(16, mutationIdFill).toString('base64url');
      const requestDigest = buf(32, mutationIdFill).toString('base64url');
      return {
        keyEpoch: '1', mutationId,
        signature: signRecord(keys.signPriv, userId, 'record.put', { keyEpoch: '1', baseVersion: '0', recordId, mutationId, requestDigest }),
        baseVersion: '0', requestDigest, recordId,
        cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const,
        nonce: buf(12, nonceFill), ciphertext: buf(50, nonceFill + 1), tag: buf(16, nonceFill + 2),
      };
    };

    const results = await Promise.allSettled([svc.putRecord(userId, build(9, 1)), svc.putRecord(userId, build(10, 2))]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'SYNC_VERSION_CONFLICT' });
  });

  it('concurrent destroy yields exactly one winner (epoch stale)', async () => {
    const userId = await makeUser(db, uniqueEmail('scc-destroy'));
    const keys = makeKeys();
    const stateRepo = new MysqlSyncStateRepo(() => db);
    await withTransaction(db, (tx) => stateRepo.create(tx, makeState(userId, keys)));

    const svc = stateSvc();
    const build = (mutationIdFill: number) => {
      const mutationId = buf(16, mutationIdFill).toString('base64url');
      const requestDigest = buf(32, mutationIdFill).toString('base64url');
      return {
        keyEpoch: '1', mutationId,
        signature: signState(keys.signPriv, userId, 'state.destroy', { keyEpoch: '1', expectedStateVersion: '1', mutationId, requestDigest }),
        expectedStateVersion: '1', requestDigest,
        newState: newState(mutationIdFill),
      };
    };

    const results = await Promise.allSettled([svc.destroy(userId, build(9)), svc.destroy(userId, build(10))]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'SYNC_EPOCH_STALE' });
    expect((fulfilled[0] as PromiseFulfilledResult<{ keyEpoch: string }>).value.keyEpoch).toBe('2');
  });
});
