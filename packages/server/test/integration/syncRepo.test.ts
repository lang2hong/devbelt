import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';
import { MysqlSyncStateRepo } from '../../src/repository/mysql/syncStateRepo.js';
import { MysqlSyncRecordRepo } from '../../src/repository/mysql/syncRecordRepo.js';
import { MysqlSyncNonceRepo } from '../../src/repository/mysql/syncNonceRepo.js';
import { MysqlSyncMutationRepo } from '../../src/repository/mysql/syncMutationRepo.js';
import { MysqlSyncResetTokenRepo } from '../../src/repository/mysql/syncResetTokenRepo.js';
import type { PersonalSyncState } from '../../src/domain/entities.js';

const URL = process.env.MYSQL_TEST_URL;

function buf(n: number, fill = 1): Buffer {
  return Buffer.alloc(n, fill);
}

function makeState(userId: number, overrides: Partial<PersonalSyncState> = {}): PersonalSyncState {
  return {
    userId,
    keyEpoch: '1',
    stateVersion: '1',
    changeSequence: '0',
    protocolVersion: 1,
    cipherSuite: 'AES-256-GCM',
    formatVersion: 1,
    smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: buf(16, 2), outputBytes: 32 },
    recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: buf(16, 3), outputBytes: 32 },
    envelopeSmp: { version: '1', nonce: buf(12, 4), ct: buf(32, 5), tag: buf(16, 6) },
    envelopeRecovery: { version: '1', nonce: buf(12, 7), ct: buf(32, 8), tag: buf(16, 9) },
    signPub: buf(32, 10),
    recoverSignPub: buf(32, 11),
    recoveryCodeSetTime: null,
    createTime: new Date(),
    updateTime: new Date(),
    ...overrides,
  };
}

async function makeUser(db: MysqlDb, email: string): Promise<number> {
  const [r] = await db.query<any>(
    "INSERT INTO users (email, password_hash, display_name, status) VALUES (?, 'hash', NULL, 'active')",
    [email],
  );
  return Number(r.insertId);
}

describe.skipIf(!URL)('personal sync repos (real MySQL)', () => {
  let pool: mysql.Pool;
  let db: MysqlDb;
  let userId: number;

  beforeAll(async () => {
    pool = createTestPool();
    db = pool as unknown as MysqlDb;
    await runMigrations(db, [...migrations]);
    userId = await makeUser(db, `sync-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sync state: create once, lock, and optimistic update', async () => {
    const repo = new MysqlSyncStateRepo(() => db);
    const base = makeState(userId, { stateVersion: '1' });

    await withTransaction(db, async (tx) => {
      expect(await repo.create(tx, base)).toBe(true);
      expect(await repo.create(tx, base)).toBe(false);
    });

    expect(await repo.findByUserId(userId)).toBeDefined();

    await withTransaction(db, async (tx) => {
      const locked = await repo.lockByUserId(tx, userId);
      expect(locked?.stateVersion).toBe('1');

      const next = makeState(userId, { stateVersion: '2', envelopeSmp: { version: '2', nonce: buf(12, 20), ct: buf(32, 21), tag: buf(16, 22) } });
      expect(await repo.update(tx, userId, '1', next)).toBe(true);
      expect(await repo.update(tx, userId, '1', next)).toBe(false);
    });
  });

  it('record: create, optimistic update, tombstone, feed, quota', async () => {
    const recordRepo = new MysqlSyncRecordRepo();
    const nonceRepo = new MysqlSyncNonceRepo();
    const recordId = buf(16, 40);

    await withTransaction(db, async (tx) => {
      expect(await nonceRepo.insert(tx, userId, '1', buf(12, 60))).toBe(true);
      expect(await nonceRepo.insert(tx, userId, '1', buf(12, 60))).toBe(false);

      const created = await recordRepo.create(tx, {
        userId, keyEpoch: '1', recordId,
        cipherSuite: 'AES-256-GCM', formatVersion: 1,
        nonce: buf(12, 60), ciphertext: buf(100, 61), tag: buf(16, 62),
        version: '1', changeSequence: '1',
      });
      expect(created.version).toBe('1');

      expect(await recordRepo.update(tx, {
        userId, keyEpoch: '1', recordId, baseVersion: '1',
        cipherSuite: 'AES-256-GCM', formatVersion: 1,
        nonce: buf(12, 63), ciphertext: buf(200, 64), tag: buf(16, 65),
        newVersion: '2', changeSequence: '2',
      })).toBe(true);
      expect(await recordRepo.update(tx, {
        userId, keyEpoch: '1', recordId, baseVersion: '1',
        cipherSuite: 'AES-256-GCM', formatVersion: 1,
        nonce: buf(12, 63), ciphertext: buf(200, 64), tag: buf(16, 65),
        newVersion: '3', changeSequence: '3',
      })).toBe(false);
    });

    await withTransaction(db, async (tx) => {
      const feed = await recordRepo.listByFeed(tx, userId, '1', '0', '10', 10);
      expect(feed).toHaveLength(1);
      expect(feed[0].ciphertext?.length).toBe(200);

      const quota = await recordRepo.countActive(tx, userId, '1');
      expect(quota.count).toBe(1);
      expect(quota.bytes).toBe(200 + 16 + 12);

      expect(await recordRepo.softDelete(tx, userId, '1', recordId, '2', '3', '3', new Date())).toBe(true);
      const afterDelete = await recordRepo.findForUpdate(tx, userId, '1', recordId);
      expect(afterDelete?.deleteTime).not.toBeNull();
      expect(afterDelete?.ciphertext).toBeNull();
      expect(await recordRepo.countActive(tx, userId, '1')).toEqual({ count: 0, bytes: 0 });
    });
  });

  it('record: listActiveByEpoch returns only active records', async () => {
    const recordRepo = new MysqlSyncRecordRepo();
    await withTransaction(db, async (tx) => {
      await recordRepo.create(tx, {
        userId, keyEpoch: '1', recordId: buf(16, 70),
        cipherSuite: 'AES-256-GCM', formatVersion: 1,
        nonce: buf(12, 71), ciphertext: buf(50, 72), tag: buf(16, 73),
        version: '1', changeSequence: '4',
      });
      const active = await recordRepo.listActiveByEpoch(tx, userId, '1');
      expect(active).toHaveLength(1);
      expect(active[0].ciphertext?.length).toBe(50);
    });
  });

  it('mutation receipt: record and read back (immutable by service)', async () => {
    const repo = new MysqlSyncMutationRepo();
    const mid = buf(16, 80);
    const digest = buf(32, 81);
    await withTransaction(db, async (tx) => {
      await repo.record(tx, {
        userId, keyEpoch: '1', mutationId: mid, requestDigest: digest,
        action: 'record.put', resultVersion: '1', resultChangeSequence: '1', status: 'applied',
        expiresTime: new Date(Date.now() + 3600_000),
      });
      const found = await repo.findByMutationId(tx, userId, '1', mid);
      expect(found?.resultVersion).toBe('1');
      expect(found?.resultChangeSequence).toBe('1');
      expect(found?.requestDigest.equals(digest)).toBe(true);
    });
  });

  it('reset token: create, revoke pending, consume, usable lookup', async () => {
    const repo = new MysqlSyncResetTokenRepo();
    const hash = buf(32, 90);
    await withTransaction(db, async (tx) => {
      const token = await repo.create(tx, { userId, tokenHash: hash, expiresTime: new Date(Date.now() + 3600_000) });
      expect((await repo.findUsableForUpdate(tx, hash))?.id).toBe(token.id);

      await repo.revokePendingByUser(tx, userId, new Date());
      expect(await repo.findUsableForUpdate(tx, hash)).toBeUndefined();
    });

    await withTransaction(db, async (tx) => {
      const token2 = await repo.create(tx, { userId, tokenHash: buf(32, 91), expiresTime: new Date(Date.now() + 3600_000) });
      expect(await repo.consume(tx, token2.id, new Date())).toBe(true);
      expect(await repo.consume(tx, token2.id, new Date())).toBe(false);
      expect(await repo.findUsableForUpdate(tx, buf(32, 91))).toBeUndefined();
    });
  });
});