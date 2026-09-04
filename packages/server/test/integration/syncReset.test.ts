import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { createHash } from 'crypto';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';
import { MysqlSyncStateRepo } from '../../src/repository/mysql/syncStateRepo.js';
import { MysqlSyncRecordRepo } from '../../src/repository/mysql/syncRecordRepo.js';
import { MysqlSyncResetTokenRepo } from '../../src/repository/mysql/syncResetTokenRepo.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';
import { MysqlRateLimitRepo } from '../../src/repository/mysql/rateLimitRepo.js';
import { SyncResetService } from '../../src/service/syncResetService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import type { SyncNewState } from '../../src/service/syncStateService.js';
import type { PersonalSyncState } from '../../src/domain/entities.js';

const URL = process.env.MYSQL_TEST_URL;

function buf(n: number, fill = 1): Buffer { return Buffer.alloc(n, fill); }
function sha(raw: Buffer): Buffer { return createHash('sha256').update(raw).digest(); }

function newState(fill = 10): SyncNewState {
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: buf(16, 2), outputBytes: 32 },
    recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: buf(16, 3), outputBytes: 32 },
    envelopeSmp: { version: '1', nonce: buf(12, fill), ct: buf(32, fill + 1), tag: buf(16, fill + 2) },
    envelopeRecovery: { version: '1', nonce: buf(12, fill + 3), ct: buf(32, fill + 4), tag: buf(16, fill + 5) },
    signPub: buf(32, fill + 6), recoverSignPub: buf(32, fill + 7),
  };
}

function makeState(userId: number, changeSequence = '0'): PersonalSyncState {
  const n = newState(20);
  return {
    userId: userId, keyEpoch: '1', stateVersion: '1', changeSequence,
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    smpKdf: n.smpKdf, recoveryKdf: n.recoveryKdf, envelopeSmp: n.envelopeSmp, envelopeRecovery: n.envelopeRecovery,
    signPub: n.signPub, recoverSignPub: n.recoverSignPub,
    recoveryCodeSetTime: null, createTime: new Date(), updateTime: new Date(),
  };
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

describe.skipIf(!URL)('sync reset-after-loss (real MySQL)', () => {
  let pool: mysql.Pool;
  let db: MysqlDb;

  beforeAll(async () => {
    pool = createTestPool();
    db = pool as unknown as MysqlDb;
    await runMigrations(db, [...migrations]);
  });

  afterAll(async () => { await pool.end(); });

  function makeSvc() {
    const stateRepo = new MysqlSyncStateRepo(() => db);
    const recordRepo = new MysqlSyncRecordRepo();
    const resetTokenRepo = new MysqlSyncResetTokenRepo();
    const userRepo = new MysqlUserRepo(() => db);
    const emailSender = new MemoryEmailSender();
    const rateLimiter = new RateLimitService(new MysqlRateLimitRepo(() => db), false);
    const svc = new SyncResetService(
      stateRepo, recordRepo, resetTokenRepo, userRepo,
      (fn) => withTransaction(db, fn), emailSender, rateLimiter,
    );
    return { stateRepo, recordRepo, resetTokenRepo, svc };
  }

  async function seed(u: ReturnType<typeof makeSvc>, userId: number, raw: Buffer): Promise<void> {
    await withTransaction(db, async (tx) => {
      await u.stateRepo.create(tx, makeState(userId, '1'));
      await u.recordRepo.create(tx, {
        userId, keyEpoch: '1', recordId: buf(16, 70),
        cipherSuite: 'AES-256-GCM', formatVersion: 1,
        nonce: buf(12, 71), ciphertext: buf(50, 72), tag: buf(16, 73),
        version: '1', changeSequence: '1',
      });
      await u.resetTokenRepo.create(tx, { userId, tokenHash: sha(raw), expiresTime: new Date(Date.now() + 3600_000) });
    });
  }

  it('rotates epoch and tombstones records on real MySQL', async () => {
    const u = makeSvc();
    const userId = await makeUser(db, uniqueEmail('sr'));
    const raw = buf(32, 90);
    await seed(u, userId, raw);

    const res = await u.svc.resetAfterLoss(userId, { resetToken: raw, newState: newState() });
    expect(res.keyEpoch).toBe('2');

    const state = await u.stateRepo.findByUserId(userId);
    expect(state?.keyEpoch).toBe('2');
    expect(state?.stateVersion).toBe('1');
    // change_sequence 从 1 起、tombstone 一条 → 2
    expect(state?.changeSequence).toBe('2');
    const activeCount = await withTransaction(db, (tx) => u.recordRepo.countActive(tx, userId, '1'));
    expect(activeCount.count).toBe(0);
  });

  it('two concurrent resetAfterLoss on the same token yield exactly one success', async () => {
    const u = makeSvc();
    const userId = await makeUser(db, uniqueEmail('scc'));
    const raw = buf(32, 91);
    await seed(u, userId, raw);

    const results = await Promise.allSettled([
      u.svc.resetAfterLoss(userId, { resetToken: raw, newState: newState() }),
      u.svc.resetAfterLoss(userId, { resetToken: raw, newState: newState() }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'VALIDATION_FAILED', message: 'reset token invalid',
    });

    const state = await u.stateRepo.findByUserId(userId);
    expect(state?.keyEpoch).toBe('2');
    expect(state?.stateVersion).toBe('1');
  });
});
