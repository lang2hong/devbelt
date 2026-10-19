import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { consoleAdminRoutes } from '../../src/modules/admin/route/consoleAdmin.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { CursorService } from '../../src/service/cursor.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { ConsoleAdminService } from '../../src/modules/admin/service/consoleAdminService.js';
import {
  FakeUserRepo,
  FakeSyncStateRepo,
  FakeSyncRecordRepo,
  FakePersonalSubscriptionRepo,
  FakePlanRepo,
  FakePlanFeatureDefRepo,
  FakeRateLimitRepo,
} from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';

function seedState(userId: number) {
  return {
    userId,
    keyEpoch: '1',
    stateVersion: '5',
    changeSequence: '128',
    protocolVersion: 2 as const,
    cipherSuite: 'aes-256-gcm' as const,
    formatVersion: 1 as const,
    smpKdf: { alg: 'argon2id' as const, version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: Buffer.alloc(16), outputBytes: 32 },
    recoveryKdf: { alg: 'hkdf-sha256' as const, version: 1, salt: Buffer.alloc(16), outputBytes: 32 },
    envelopeSmp: { version: '1', nonce: Buffer.alloc(12), ct: Buffer.alloc(32), tag: Buffer.alloc(16) },
    envelopeRecovery: { version: '1', nonce: Buffer.alloc(12), ct: Buffer.alloc(32), tag: Buffer.alloc(16) },
    recoveryEnvelope: { version: '1', nonce: Buffer.alloc(12), ct: Buffer.alloc(48), tag: Buffer.alloc(16) },
    quotaUsedBytes: 0,
    updateTime: new Date(),
  };
}

async function build() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  const syncStateRepo = new FakeSyncStateRepo();
  const recordRepo = new FakeSyncRecordRepo();
  const auditRepo = new FakeAuditRepo();
  const auditWriter = new AuditWriter(auditRepo);

  const svc = new ConsoleAdminService({
    userRepo,
    refreshTokenRepo: {} as never,
    planRepo: new FakePlanRepo(),
    featureDefRepo: new FakePlanFeatureDefRepo([]),
    personalSubscriptionRepo: new FakePersonalSubscriptionRepo(),
    auditRepo,
    orderRepo: {} as never,
    invoiceRepo: {} as never,
    auditWriter,
    syncStateRepo,
    syncRecordService: {
      listMetadataByKind: (uid: number, epoch: string, opts: { kind?: string; afterId?: number; limit: number }) =>
        recordRepo.listMetadataByKind({} as Queryable, uid, epoch, opts),
    } as never,
  });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 1);
  const csrfService = new CsrfService(Buffer.alloc(32, 11));

  await app.register(consoleAdminRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    csrfService,
    consoleOrigin: ORIGIN,
    rateLimiter: new RateLimitService(new FakeRateLimitRepo(), false),
    idempotencyService: {} as never,
    adminService: svc,
    cursorService: new CursorService(Buffer.alloc(32, 7)),
    planRepo: new FakePlanRepo(),
    serverVersion: '1.0.0',
    consoleApiVersion: '1',
  });
  await app.ready();

  const headers = async (userId: number) => {
    const csrf = csrfService.issue('ws');
    return {
      authorization: `Bearer ${await tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 })}`,
      origin: ORIGIN,
      'x-csrf-token': csrf,
      cookie: `${csrfCookieName()}=${csrf}`,
      accept: 'application/json',
    };
  };

  return { app, userRepo, syncStateRepo, recordRepo, auditRepo, headers };
}

describe('console admin sync-records routes（后台同步明细受限读）', () => {
  it('返回 state 元数据 + 记录明细（id 倒序、hex 记录ID、无密文字段）并写受限读审计', async () => {
    const b = await build();
    const admin = await b.userRepo.create('admin@b.com', 'hash', undefined);
    await b.userRepo.setRole(admin.id, 'platform_admin');
    const u = await b.userRepo.create('u@b.com', 'hash', undefined);
    b.syncStateRepo.store.set(u.id, seedState(u.id) as never);
    await b.recordRepo.create({} as Queryable, {
      userId: u.id, keyEpoch: '1', recordId: Buffer.from([1, 2, 3, 4]),
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(100), tag: Buffer.alloc(16),
      version: '1', changeSequence: '10', entityKind: 'SavedConnection',
    });
    await b.recordRepo.create({} as Queryable, {
      userId: u.id, keyEpoch: '1', recordId: Buffer.from([5, 6, 7, 8]),
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(60), tag: Buffer.alloc(16),
      version: '2', changeSequence: '11', entityKind: 'Snippet',
    });
    // tombstone：不进明细。
    const deleted = await b.recordRepo.create({} as Queryable, {
      userId: u.id, keyEpoch: '1', recordId: Buffer.from([9, 10, 11, 12]),
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(40), tag: Buffer.alloc(16),
      version: '1', changeSequence: '12', entityKind: 'SavedConnection',
    });
    await b.recordRepo.softDelete({} as Queryable, u.id, '1', Buffer.from([9, 10, 11, 12]), '1', '13', '14', new Date());

    const res = await b.app.inject({ method: 'GET', url: `/api/admin/users/${u.id}/sync-records`, headers: await b.headers(admin.id) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toMatchObject({ keyEpoch: '1', stateVersion: '5', changeSequence: '128' });
    expect(body.items).toHaveLength(2);
    // id 倒序（后创建的在前），hex 小写，bytes = ct+tag+nonce。
    expect(body.items[0]).toMatchObject({ recordId: '05060708', entityKind: 'Snippet', version: '2', changeSequence: '11', bytes: 60 + 16 + 12 });
    expect(body.items[1]).toMatchObject({ recordId: '01020304', entityKind: 'SavedConnection' });
    // DTO 绝不含密文本体字段。
    for (const item of body.items) {
      expect(item.ciphertext).toBeUndefined();
      expect(item.nonce).toBeUndefined();
      expect(item.tag).toBeUndefined();
    }
    expect(body.nextCursor).toBeNull();
    expect(deleted.recordId.toString('hex')).toBe('090a0b0c');
    expect(body.items.some((i: { recordId: string }) => i.recordId === '090a0b0c')).toBe(false);
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.users.read')).toBe(true);
  });

  it('kind 过滤 + limit 分页（游标翻页到尽头 nextCursor=null）', async () => {
    const b = await build();
    const admin = await b.userRepo.create('admin@b.com', 'hash', undefined);
    await b.userRepo.setRole(admin.id, 'platform_admin');
    const u = await b.userRepo.create('u@b.com', 'hash', undefined);
    b.syncStateRepo.store.set(u.id, seedState(u.id) as never);
    for (let i = 0; i < 3; i++) {
      await b.recordRepo.create({} as Queryable, {
        userId: u.id, keyEpoch: '1', recordId: Buffer.from([i]),
        cipherSuite: 'AES-256-GCM', formatVersion: 1,
        nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(10), tag: Buffer.alloc(16),
        version: '1', changeSequence: String(10 + i), entityKind: i === 1 ? 'Snippet' : 'SavedConnection',
      });
    }

    const kindRes = await b.app.inject({
      method: 'GET', url: `/api/admin/users/${u.id}/sync-records?kind=Snippet`, headers: await b.headers(admin.id),
    });
    expect(kindRes.json().items).toHaveLength(1);
    expect(kindRes.json().items[0].entityKind).toBe('Snippet');

    const page1 = await b.app.inject({
      method: 'GET', url: `/api/admin/users/${u.id}/sync-records?limit=2`, headers: await b.headers(admin.id),
    });
    expect(page1.json().items).toHaveLength(2);
    expect(page1.json().nextCursor).toBeTruthy();
    const page2 = await b.app.inject({
      method: 'GET', url: `/api/admin/users/${u.id}/sync-records?limit=2&cursor=${page1.json().nextCursor}`, headers: await b.headers(admin.id),
    });
    expect(page2.json().items).toHaveLength(1);
    expect(page2.json().nextCursor).toBeNull();
  });

  it('无同步态返回 state=null + 空列表；非管理员 403；用户不存在 404；坏游标 422', async () => {
    const b = await build();
    const admin = await b.userRepo.create('admin@b.com', 'hash', undefined);
    await b.userRepo.setRole(admin.id, 'platform_admin');
    const u = await b.userRepo.create('u@b.com', 'hash', undefined);

    const empty = await b.app.inject({ method: 'GET', url: `/api/admin/users/${u.id}/sync-records`, headers: await b.headers(admin.id) });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().state).toBeNull();
    expect(empty.json().items).toEqual([]);

    const forbidden = await b.app.inject({ method: 'GET', url: `/api/admin/users/${u.id}/sync-records`, headers: await b.headers(u.id) });
    expect(forbidden.statusCode).toBe(403);

    const notFound = await b.app.inject({ method: 'GET', url: '/api/admin/users/999/sync-records', headers: await b.headers(admin.id) });
    expect(notFound.statusCode).toBe(404);

    b.syncStateRepo.store.set(u.id, seedState(u.id) as never);
    await b.recordRepo.create({} as Queryable, {
      userId: u.id, keyEpoch: '1', recordId: Buffer.from([1]),
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(10), tag: Buffer.alloc(16),
      version: '1', changeSequence: '10', entityKind: 'SavedConnection',
    });
    const badCursor = await b.app.inject({
      method: 'GET', url: `/api/admin/users/${u.id}/sync-records?cursor=tampered.c2ln`, headers: await b.headers(admin.id),
    });
    expect(badCursor.statusCode).toBe(422);
  });
});
