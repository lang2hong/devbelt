import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { consoleAdminRoutes } from '../../src/modules/admin/route/consoleAdmin.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { IdempotencyService } from '../../src/service/idempotencyService.js';
import { ConsoleAdminService } from '../../src/modules/admin/service/consoleAdminService.js';
import { CursorService } from '../../src/service/cursor.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { MemoryEmailSender, type EmailSender } from '../../src/modules/auth/service/emailSender.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import {
  FakeUserRepo,
  FakePlanRepo,
  FakePlanFeatureDefRepo,
  FakePersonalSubscriptionRepo,
  FakeRateLimitRepo,
  FakeIdempotencyReceiptRepo,
} from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable, TxRunner } from '../../src/repository/mysql/db.js';
import type {
  FeedbackEmailStatus,
  FeedbackReply,
  FeedbackRow,
  IFeedbackRepo,
} from '../../src/repository/interfaces/feedback.js';

const ORIGIN = 'http://localhost:5173';

/** 内存反馈仓储：只实现回复链路用到的方法。 */
class MemFeedbackRepo {
  readonly rows = new Map<number, FeedbackRow>();
  readonly replies: FeedbackReply[] = [];
  readonly emailByUser = new Map<number, string>();

  seed(row: Partial<FeedbackRow> & { id: number }): void {
    this.rows.set(row.id, {
      userId: null,
      userEmail: null,
      installId: 'inst-1',
      hasReplyKey: true,
      category: 'bug',
      content: 'grid scrollbar disappears',
      contact: null,
      appVersion: '0.4.1',
      os: 'linux/x64',
      status: 'new',
      adminNote: null,
      sourceIp: '127.0.0.1',
      createTime: new Date(),
      updateTime: new Date(),
      ...row,
    });
  }

  repo(): IFeedbackRepo {
    return {
      create: async () => 0,
      list: async () => ({ items: [], nextId: null, total: 0 }),
      updateStatusInTx: async () => false,
      overview: async () => { throw new Error('unused'); },
      listThread: async () => [],
      findDetail: async (id) => {
        const f = this.rows.get(id);
        if (!f) return undefined;
        return {
          feedback: f,
          userEmail: f.userId !== null ? this.emailByUser.get(f.userId) ?? null : null,
          replies: this.replies.filter((r) => r.feedbackId === id),
        };
      },
      findForReplyInTx: async (_tx, id) => {
        const f = this.rows.get(id);
        if (!f) return undefined;
        return {
          id: f.id,
          status: f.status,
          content: f.content,
          contact: f.contact,
          userEmail: f.userId !== null ? this.emailByUser.get(f.userId) ?? null : null,
        };
      },
      createReplyInTx: async (_tx, input) => {
        const id = this.replies.length + 1;
        this.replies.push({
          id,
          feedbackId: input.feedbackId,
          adminUserId: input.adminUserId,
          body: input.body,
          emailStatus: input.emailStatus,
          emailTo: input.emailTo,
          emailError: null,
          createTime: new Date(),
        });
        return id;
      },
      markTriagedIfNewInTx: async (_tx, id) => {
        const f = this.rows.get(id);
        if (f && f.status === 'new') f.status = 'triaged';
      },
      updateReplyEmail: async (replyId, status, error) => {
        const r = this.replies.find((x) => x.id === replyId);
        if (r && r.emailStatus === 'pending') {
          r.emailStatus = status as FeedbackEmailStatus;
          r.emailError = error;
        }
      },
    };
  }
}

async function build(opts: { emailSender?: EmailSender | null } = {}) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  const auditRepo = new FakeAuditRepo();
  const idemRepo = new FakeIdempotencyReceiptRepo();
  const feedback = new MemFeedbackRepo();
  const mail = new MemoryEmailSender();
  const emailSender = opts.emailSender === null ? undefined : opts.emailSender ?? mail;

  const runner: TxRunner = async (fn) => fn({} as Queryable);
  const adminService = new ConsoleAdminService({
    feedbackRepo: feedback.repo(),
    telemetryRepo: {
      record: async () => undefined,
      overview: async () => ({ totalInstalls: 0, newInstalls7d: 0, newInstalls30d: 0, active24h: 0, active7d: 0, active30d: 0, daily: [] }),
    },
    emailSender,
    userRepo,
    refreshTokenRepo: {} as never,
    planRepo: new FakePlanRepo(),
    featureDefRepo: new FakePlanFeatureDefRepo([]),
    personalSubscriptionRepo: new FakePersonalSubscriptionRepo(),
    auditRepo,
    orderRepo: {} as never,
    invoiceRepo: {} as never,
    auditWriter: new AuditWriter(auditRepo),
    syncStateRepo: {} as never,
    syncRecordService: {} as never,
  });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 11));

  await app.register(consoleAdminRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    csrfService,
    consoleOrigin: ORIGIN,
    rateLimiter: new RateLimitService(new FakeRateLimitRepo(), false),
    idempotencyService: new IdempotencyService(idemRepo, runner),
    adminService,
    cursorService: new CursorService(Buffer.alloc(32, 7)),
    planRepo: new FakePlanRepo(),
    serverVersion: '1.0.0',
    consoleApiVersion: '1',
  });
  await app.ready();

  const admin = await userRepo.create('admin@b.com', 'hash', undefined);
  await userRepo.setRole(admin.id, 'platform_admin');
  const token = await tokenService.signAccessToken({ userId: admin.id, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 });

  const readHeaders = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const writeHeaders = (key = randomUUID()) => {
    const csrf = csrfService.issue('ws');
    return {
      ...readHeaders,
      origin: ORIGIN,
      'x-csrf-token': csrf,
      cookie: `${csrfCookieName()}=${csrf}`,
      'idempotency-key': key,
      'content-type': 'application/json',
    };
  };

  return { app, feedback, mail, auditRepo, admin, readHeaders, writeHeaders };
}

describe('POST /api/admin/feedback/:id/replies', () => {
  it('站内回复：写回复、new→triaged、审计不含正文', async () => {
    const b = await build();
    b.feedback.seed({ id: 1 });
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/admin/feedback/1/replies',
      headers: b.writeHeaders(),
      payload: { body: '已在 0.4.2 修复', emailTarget: 'none' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: '1', emailStatus: 'skipped' });
    expect(b.feedback.replies[0]).toMatchObject({ body: '已在 0.4.2 修复', emailStatus: 'skipped', adminUserId: b.admin.id });
    expect(b.feedback.rows.get(1)!.status).toBe('triaged');
    expect(b.mail.sent).toHaveLength(0);
    const audit = b.auditRepo.events.find((e) => e.eventType === 'admin.feedback.replied');
    expect(audit).toMatchObject({ targetId: '1', reason: 'email:none' });
    expect(JSON.stringify(audit)).not.toContain('0.4.2');
  });

  it('done/rejected 状态回复后保持不变', async () => {
    const b = await build();
    b.feedback.seed({ id: 1, status: 'done' });
    await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(),
      payload: { body: 'follow-up', emailTarget: 'none' },
    });
    expect(b.feedback.rows.get(1)!.status).toBe('done');
  });

  it('contact 邮箱：提交后发信并记录 sent', async () => {
    const b = await build();
    b.feedback.seed({ id: 1, contact: 'user@example.test' });
    const res = await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(),
      payload: { body: 'thanks', emailTarget: 'contact' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().emailStatus).toBe('sent');
    expect(b.mail.sent).toEqual([{ kind: 'feedback_reply', to: 'user@example.test', reply: 'thanks' }]);
    expect(b.feedback.replies[0]).toMatchObject({ emailStatus: 'sent', emailTo: 'user@example.test' });
  });

  it('账号邮箱：关联账号时发到账号邮箱', async () => {
    const b = await build();
    b.feedback.seed({ id: 1, userId: 77 });
    b.feedback.emailByUser.set(77, 'owner@example.test');
    const res = await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(),
      payload: { body: 'hi', emailTarget: 'account' },
    });
    expect(res.statusCode).toBe(201);
    expect(b.mail.sent[0]?.to).toBe('owner@example.test');
  });

  it('同一幂等键重放不重复写回复、不重复发信', async () => {
    const b = await build();
    b.feedback.seed({ id: 1, contact: 'user@example.test' });
    const key = randomUUID();
    const payload = { body: 'once', emailTarget: 'contact' };
    const first = await b.app.inject({ method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(key), payload });
    const second = await b.app.inject({ method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(key), payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(b.feedback.replies).toHaveLength(1);
    expect(b.mail.sent).toHaveLength(1);
  });

  it('发信失败记录 failed，站内回复仍保留', async () => {
    const failing: EmailSender = {
      ...new MemoryEmailSender(),
      sendVerificationEmail: async () => undefined,
      sendAlreadyRegisteredEmail: async () => undefined,
      sendResetChallengeEmail: async () => undefined,
      sendAccountRecoveryActivityEmail: async () => undefined,
      sendFeedbackReplyEmail: async () => { throw new Error('smtp down'); },
    };
    const b = await build({ emailSender: failing });
    b.feedback.seed({ id: 1, contact: 'user@example.test' });
    const res = await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(),
      payload: { body: 'x', emailTarget: 'contact' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().emailStatus).toBe('failed');
    expect(b.feedback.replies[0]).toMatchObject({ body: 'x', emailStatus: 'failed' });
    expect(b.feedback.replies[0]!.emailError).not.toContain('smtp down');
  });

  it('未配置发信器时记录 failed', async () => {
    const b = await build({ emailSender: null });
    b.feedback.seed({ id: 1, contact: 'user@example.test' });
    const res = await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(),
      payload: { body: 'x', emailTarget: 'contact' },
    });
    expect(res.json().emailStatus).toBe('failed');
  });

  it('选 account 但未关联账号 / contact 不是邮箱 → 422，且不写回复', async () => {
    const b = await build();
    b.feedback.seed({ id: 1, contact: 'wechat: abc' });
    const r1 = await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(),
      payload: { body: 'x', emailTarget: 'account' },
    });
    const r2 = await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(),
      payload: { body: 'x', emailTarget: 'contact' },
    });
    expect(r1.statusCode).toBe(422);
    expect(r2.statusCode).toBe(422);
    expect(b.feedback.replies).toHaveLength(0);
  });

  it('不存在的反馈 → 404；空白正文 → 422', async () => {
    const b = await build();
    b.feedback.seed({ id: 1 });
    const missing = await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/999/replies', headers: b.writeHeaders(),
      payload: { body: 'x', emailTarget: 'none' },
    });
    expect(missing.statusCode).toBe(404);
    const blank = await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(),
      payload: { body: '   ', emailTarget: 'none' },
    });
    expect(blank.statusCode).toBe(422);
  });

  it('缺 CSRF → 403', async () => {
    const b = await build();
    b.feedback.seed({ id: 1 });
    const res = await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies',
      headers: { ...b.readHeaders, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: { body: 'x', emailTarget: 'none' },
    });
    expect(res.statusCode).toBe(403);
    expect(b.feedback.replies).toHaveLength(0);
  });
});

describe('GET /api/admin/feedback/:id', () => {
  it('返回详情、账号邮箱、站内可达性与回复历史', async () => {
    const b = await build();
    b.feedback.seed({ id: 1, userId: 77, hasReplyKey: false });
    b.feedback.emailByUser.set(77, 'owner@example.test');
    b.feedback.seed({ id: 2, hasReplyKey: false });
    await b.app.inject({
      method: 'POST', url: '/api/admin/feedback/1/replies', headers: b.writeHeaders(),
      payload: { body: 'r1', emailTarget: 'none' },
    });

    const d1 = await b.app.inject({ method: 'GET', url: '/api/admin/feedback/1', headers: b.readHeaders });
    expect(d1.statusCode).toBe(200);
    const j1 = d1.json();
    expect(j1.userEmail).toBe('owner@example.test');
    expect(j1.inAppDeliverable).toBe(true);
    expect(j1.replies).toHaveLength(1);
    expect(j1.replies[0]).toMatchObject({ body: 'r1', emailStatus: 'skipped' });
    expect(JSON.stringify(j1)).not.toContain('reply_key_hash');

    const d2 = await b.app.inject({ method: 'GET', url: '/api/admin/feedback/2', headers: b.readHeaders });
    expect(d2.json().inAppDeliverable).toBe(false);

    const d404 = await b.app.inject({ method: 'GET', url: '/api/admin/feedback/999', headers: b.readHeaders });
    expect(d404.statusCode).toBe(404);
  });
});
