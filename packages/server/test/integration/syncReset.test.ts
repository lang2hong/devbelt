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
import { MysqlSyncResetHandoffRepo } from '../../src/repository/mysql/syncResetHandoffRepo.js';
import { MysqlMailFlowRepo } from '../../src/repository/mysql/mailFlowRepo.js';
import { MysqlAuditRepo } from '../../src/repository/mysql/auditRepo.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';
import { MysqlRateLimitRepo } from '../../src/repository/mysql/rateLimitRepo.js';
import { SyncResetService } from '../../src/service/syncResetService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender } from '../../src/service/emailSender.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
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
    envelopeRecovery: { version: '1', nonce: buf(12, fill + 3), ct: buf(32, fill + 4), tag: buf(16, fill + 4) },
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

describe.skipIf(!URL)('sync reset-after-loss handoff (real MySQL)', () => {
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
    const resetTokenRepo = new MysqlSyncResetTokenRepo(() => db);
    const handoffRepo = new MysqlSyncResetHandoffRepo(() => db);
    const mailFlowRepo = new MysqlMailFlowRepo(() => db);
    const userRepo = new MysqlUserRepo(() => db);
    const emailSender = new MemoryEmailSender();
    const rateLimiter = new RateLimitService(new MysqlRateLimitRepo(() => db), false);
    const auditWriter = new AuditWriter(new MysqlAuditRepo(() => db));
    const svc = new SyncResetService(
      stateRepo, recordRepo, resetTokenRepo, userRepo,
      (fn) => withTransaction(db, fn), emailSender, rateLimiter,
      mailFlowRepo, handoffRepo, auditWriter, 'lang2hong.vscode-db-client',
    );
    return { stateRepo, recordRepo, resetTokenRepo, mailFlowRepo, svc };
  }

  /** 建 state + record + reset token + sync-reset mail_flow，签发 handoff 得到 ticket。 */
  async function seed(userId: number, raw: Buffer): Promise<{ ticket: Buffer; tokenId: number }> {
    const u = makeSvc();
    const tokenId = await withTransaction(db, async (tx) => {
      await u.stateRepo.create(tx, makeState(userId, '1'));
      await u.recordRepo.create(tx, {
        userId, keyEpoch: '1', recordId: buf(16, 70),
        cipherSuite: 'AES-256-GCM', formatVersion: 1,
        nonce: buf(12, 71), ciphertext: buf(50, 72), tag: buf(16, 73),
        version: '1', changeSequence: '1',
      });
      const token = await u.resetTokenRepo.create(tx, { userId, tokenHash: sha(raw), expiresTime: new Date(Date.now() + 3600_000) });
      return token.id;
    });

    const nonce = Buffer.alloc(32, 7).toString('base64url');
    await u.mailFlowRepo.create({
      type: 'sync-reset',
      targetTokenHash: sha(raw),
      targetRecordId: tokenId,
      userId,
      nonceHash: sha(Buffer.from(nonce, 'utf8')),
      expiresTime: new Date(Date.now() + 600_000),
    });
    const { openUri } = await u.svc.createHandoff(nonce, userId);
    return { ticket: Buffer.from(openUri.split('handoffTicket=')[1], 'base64url'), tokenId };
  }

  it('rotates epoch and tombstones records on real MySQL', async () => {
    const u = makeSvc();
    const userId = await makeUser(db, uniqueEmail('sr'));
    const raw = buf(32, 90);
    const { ticket } = await seed(userId, raw);

    const dto = await u.svc.resetAfterLossWithHandoff(userId, { handoffTicket: ticket, newState: newState(), requestDigest: buf(32, 0xab) });
    expect(dto.keyEpoch).toBe('2');

    const state = await u.stateRepo.findByUserId(userId);
    expect(state?.keyEpoch).toBe('2');
    expect(state?.stateVersion).toBe('1');
    expect(state?.changeSequence).toBe('2');
    const activeCount = await withTransaction(db, (tx) => u.recordRepo.countActive(tx, userId, '1'));
    expect(activeCount.count).toBe(0);
  });

  it('two concurrent consumer calls with the same ticket and digest both return the same StateDto', async () => {
    const u = makeSvc();
    const userId = await makeUser(db, uniqueEmail('scc'));
    const raw = buf(32, 91);
    const { ticket } = await seed(userId, raw);

    const results = await Promise.all([
      u.svc.resetAfterLossWithHandoff(userId, { handoffTicket: ticket, newState: newState(), requestDigest: buf(32, 0xab) }),
      u.svc.resetAfterLossWithHandoff(userId, { handoffTicket: ticket, newState: newState(), requestDigest: buf(32, 0xab) }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].keyEpoch).toBe('2');

    // 状态只旋转一次，旧 records 只 tombstone 一次。
    const state = await u.stateRepo.findByUserId(userId);
    expect(state?.keyEpoch).toBe('2');
    expect(state?.stateVersion).toBe('1');
    expect(state?.changeSequence).toBe('2');
    const activeCount = await withTransaction(db, (tx) => u.recordRepo.countActive(tx, userId, '1'));
    expect(activeCount.count).toBe(0);
  });

  it('a different digest after completion returns SYNC_RESET_HANDOFF_REUSED', async () => {
    const u = makeSvc();
    const userId = await makeUser(db, uniqueEmail('srd'));
    const raw = buf(32, 92);
    const { ticket } = await seed(userId, raw);

    await u.svc.resetAfterLossWithHandoff(userId, { handoffTicket: ticket, newState: newState(), requestDigest: buf(32, 0xab) });
    await expect(
      u.svc.resetAfterLossWithHandoff(userId, { handoffTicket: ticket, newState: newState(), requestDigest: buf(32, 0xcd) }),
    ).rejects.toMatchObject({ code: 'SYNC_RESET_HANDOFF_REUSED' });
  });
});