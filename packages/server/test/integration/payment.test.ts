import { describe, it, expect } from 'vitest';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import { MysqlOrderRepo } from '../../src/repository/mysql/orderRepo.js';
import { MysqlPaymentRepo } from '../../src/repository/mysql/paymentRepo.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';
import { MysqlPlanRepo } from '../../src/repository/mysql/planRepo.js';
import { MysqlPersonalSubscriptionRepo } from '../../src/repository/mysql/personalSubscriptionRepo.js';
import { OrderService } from '../../src/service/paymentService.js';
import { MemoryPaymentGateway, signMemoryCallback } from '../../src/service/paymentChannel.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';

const URL = process.env.MYSQL_TEST_URL;

async function makeUser(db: MysqlDb): Promise<number> {
  const repo = new MysqlUserRepo(() => db);
  const user = await repo.create(
    `p4-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    'hash',
    'P4',
  );
  // 注册流程（registrationRepo）恒建 Free 订阅；此处直建 user，须补订阅以满足
  // applyEntitlementInTx 的前置（真实用户必有订阅）。
  const planRepo = new MysqlPlanRepo(() => db);
  const subRepo = new MysqlPersonalSubscriptionRepo(() => db);
  const plan = await planRepo.findByCode('free');
  await subRepo.create({
    userId: user.id,
    planId: plan!.id,
    status: 'active',
    periodStartTime: new Date(),
    periodEndTime: null,
  });
  return user.id;
}

function uniqueTradeNo(): string {
  return `wx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * 真库支付不变量（P4 切片 1，首选门禁）：
 * - 回调在一方事务内建流水 + 推进订单，回读必须走同一事务连接；
 * - advance 的 expectedStatus CAS：状态已被推进后二次推进返回 false；
 * - payments(channel, channel_trade_no) 唯一键拒绝重复回调写入。
 */
describe.skipIf(!URL)('payment repo (real MySQL)', () => {
  it('creates payment and advances order atomically on one connection', async () => {
    const pool = createTestPool();
    await runMigrations(pool as unknown as MysqlDb, [...migrations]);
    const db = pool as unknown as MysqlDb;
    try {
      const userId = await makeUser(db);
      const orderRepo = new MysqlOrderRepo(() => db);
      const paymentRepo = new MysqlPaymentRepo();

      const order = await orderRepo.create({
        orderNo: `ord-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        userId,
        planCode: 'pro',
        planVersion: 1,
        amountCents: 9900,
        channel: 'wechat',
        expiresTime: new Date(Date.now() + 30 * 60 * 1000),
      });

      await withTransaction(db, async (tx) => {
        const locked = await orderRepo.findByOrderNoForUpdate(tx, order.orderNo);
        expect(locked).toBeDefined();
        const advanced = await orderRepo.advance(tx, {
          id: locked!.id,
          expectedStatus: 'pending',
          status: 'paid',
          channelTradeNo: uniqueTradeNo(),
          paidTime: new Date(),
        });
        expect(advanced).toBe(true);

        await paymentRepo.create(tx, {
          orderId: locked!.id,
          channel: 'wechat',
          channelTradeNo: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          amountCents: 9900,
          notifySummary: '{}',
          result: 'success',
        });
      });

      const after = await orderRepo.findByOrderNo(order.orderNo);
      expect(after!.status).toBe('paid');
    } finally {
      await pool.end();
    }
  });

  it('advance is a no-op (false) when the expected status no longer matches', async () => {
    const pool = createTestPool();
    await runMigrations(pool as unknown as MysqlDb, [...migrations]);
    const db = pool as unknown as MysqlDb;
    try {
      const userId = await makeUser(db);
      const orderRepo = new MysqlOrderRepo(() => db);
      const order = await orderRepo.create({
        orderNo: `ord-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        userId,
        planCode: 'pro',
        planVersion: 1,
        amountCents: 9900,
        channel: 'wechat',
        expiresTime: new Date(Date.now() + 30 * 60 * 1000),
      });

      // 第一次推进 pending → paid。
      await withTransaction(db, async (tx) => {
        const ok = await orderRepo.advance(tx, {
          id: order.id,
          expectedStatus: 'pending',
          status: 'paid',
          channelTradeNo: uniqueTradeNo(),
          paidTime: new Date(),
        });
        expect(ok).toBe(true);
      });

      // 第二次以 pending 为期望再次推进 → 0 行命中 → false。
      await withTransaction(db, async (tx) => {
        const ok = await orderRepo.advance(tx, {
          id: order.id,
          expectedStatus: 'pending',
          status: 'paid',
          channelTradeNo: uniqueTradeNo(),
          paidTime: new Date(),
        });
        expect(ok).toBe(false);
      });
    } finally {
      await pool.end();
    }
  });

  it('rejects a duplicate (channel, channel_trade_no) payment write', async () => {
    const pool = createTestPool();
    await runMigrations(pool as unknown as MysqlDb, [...migrations]);
    const db = pool as unknown as MysqlDb;
    try {
      const userId = await makeUser(db);
      const orderRepo = new MysqlOrderRepo(() => db);
      const paymentRepo = new MysqlPaymentRepo();
      const order = await orderRepo.create({
        orderNo: `ord-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        userId,
        planCode: 'pro',
        planVersion: 1,
        amountCents: 9900,
        channel: 'wechat',
        expiresTime: new Date(Date.now() + 30 * 60 * 1000),
      });
      const tradeNo = uniqueTradeNo();

      await withTransaction(db, async (tx) => {
        await orderRepo.advance(tx, {
          id: order.id,
          expectedStatus: 'pending',
          status: 'paid',
          channelTradeNo: tradeNo,
          paidTime: new Date(),
        });
        await paymentRepo.create(tx, {
          orderId: order.id,
          channel: 'wechat',
          channelTradeNo: tradeNo,
          amountCents: 9900,
          notifySummary: '{}',
          result: 'success',
        });
      });

      // 同渠道同交易号的第二次写入：唯一键 uq_payments_channel_trade 必须拒绝。
      await expect(
        withTransaction(db, async (tx) => {
          await paymentRepo.create(tx, {
            orderId: order.id,
            channel: 'wechat',
            channelTradeNo: tradeNo,
            amountCents: 9900,
            notifySummary: '{}',
            result: 'success',
          });
        }),
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });

  it('OrderService end-to-end: create → callback fulfills → entitlement + idempotent duplicate', async () => {
    const pool = createTestPool();
    await runMigrations(pool as unknown as MysqlDb, [...migrations]);
    const db = pool as unknown as MysqlDb;
    try {
      const userId = await makeUser(db);
      const orderRepo = new MysqlOrderRepo(() => db);
      const paymentRepo = new MysqlPaymentRepo();
      const planRepo = new MysqlPlanRepo(() => db);
      const subRepo = new MysqlPersonalSubscriptionRepo(() => db);
      const auditWriter = new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any);
      const svc = new OrderService({
        orderRepo,
        paymentRepo,
        planRepo,
        personalSubscriptionRepo: subRepo,
        auditWriter,
        runner: (fn) => withTransaction(db, fn),
        gatewayFor: (c) => new MemoryPaymentGateway(c),
      });

      const { orderNo } = await svc.createOrder(userId, 'pro', 'wechat');
      const cbBody = Buffer.from(JSON.stringify({ orderNo, channelTradeNo: uniqueTradeNo(), amountCents: 9900, status: 'success' }));
      const headers = { 'x-payment-signature': signMemoryCallback(cbBody) };

      const outcome = await svc.handleCallback('wechat', cbBody, headers);
      expect(outcome.kind).toBe('fulfilled');

      const order = await orderRepo.findByOrderNo(orderNo);
      expect(order!.status).toBe('fulfilled');
      const sub = await subRepo.findByUserId(userId);
      expect(sub!.planId).toBeGreaterThan(0);
      const proPlan = await planRepo.findByCode('pro');
      expect(proPlan!.features.maxConnectionMetas).toBe(5000);

      // 重复回调（同 trade_no）→ duplicate，不再推进/改写。
      const dup = await svc.handleCallback('wechat', cbBody, headers);
      expect(dup.kind).toBe('duplicate');
    } finally {
      await pool.end();
    }
  });

  it('two simultaneous identical callbacks resolve with exactly one fulfillment and one duplicate', async () => {
    const pool = createTestPool();
    await runMigrations(pool as unknown as MysqlDb, [...migrations]);
    const db = pool as unknown as MysqlDb;
    try {
      const userId = await makeUser(db);
      const orderRepo = new MysqlOrderRepo(() => db);
      const paymentRepo = new MysqlPaymentRepo();
      const planRepo = new MysqlPlanRepo(() => db);
      const subRepo = new MysqlPersonalSubscriptionRepo(() => db);
      const auditWriter = new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any);
      const svc = new OrderService({
        orderRepo,
        paymentRepo,
        planRepo,
        personalSubscriptionRepo: subRepo,
        auditWriter,
        runner: (fn) => withTransaction(db, fn),
        gatewayFor: (c) => new MemoryPaymentGateway(c),
      });

      const { orderNo } = await svc.createOrder(userId, 'pro', 'wechat');
      const tradeNo = uniqueTradeNo();
      const cbBody = Buffer.from(JSON.stringify({ orderNo, channelTradeNo: tradeNo, amountCents: 9900, status: 'success' }));
      const headers = { 'x-payment-signature': signMemoryCallback(cbBody) };

      const [a, b] = await Promise.all([
        svc.handleCallback('wechat', cbBody, headers),
        svc.handleCallback('wechat', cbBody, headers),
      ]);

      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(['duplicate', 'fulfilled']);

      const order = await orderRepo.findByOrderNo(orderNo);
      expect(order!.status).toBe('fulfilled');
      // 恰一条 success 流水。
      const [successRows] = await pool.query(
        'SELECT COUNT(*) AS c FROM payments WHERE channel = ? AND channel_trade_no = ? AND result = ?',
        ['wechat', tradeNo, 'success'],
      );
      const successCount = Number((successRows as any[])[0].c ?? 0);
      expect(successCount).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('two different orders sharing one trade number yield one fulfillment, one rejected, no unhandled DB error', async () => {
    const pool = createTestPool();
    await runMigrations(pool as unknown as MysqlDb, [...migrations]);
    const db = pool as unknown as MysqlDb;
    try {
      // 两个**不同用户**、同一渠道（wechat）、同一套餐，保证二者不会因 P2-E 互相 expire，
      // 且命中 payments 的 uq_payments_channel_trade 唯一键。
      const userA = await makeUser(db);
      const userB = await makeUser(db);
      const orderRepo = new MysqlOrderRepo(() => db);
      const paymentRepo = new MysqlPaymentRepo();
      const planRepo = new MysqlPlanRepo(() => db);
      const subRepo = new MysqlPersonalSubscriptionRepo(() => db);
      const auditWriter = new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any);
      const svc = new OrderService({
        orderRepo,
        paymentRepo,
        planRepo,
        personalSubscriptionRepo: subRepo,
        auditWriter,
        runner: (fn) => withTransaction(db, fn),
        gatewayFor: (c) => new MemoryPaymentGateway(c),
      });

      const orderA = await svc.createOrder(userA, 'pro', 'wechat');
      const orderB = await svc.createOrder(userB, 'pro', 'wechat');
      const tradeNo = uniqueTradeNo();

      const bodyA = Buffer.from(JSON.stringify({ orderNo: orderA.orderNo, channelTradeNo: tradeNo, amountCents: 9900, status: 'success' }));
      const bodyB = Buffer.from(JSON.stringify({ orderNo: orderB.orderNo, channelTradeNo: tradeNo, amountCents: 9900, status: 'success' }));

      const [ra, rb] = await Promise.all([
        svc.handleCallback('wechat', bodyA, { 'x-payment-signature': signMemoryCallback(bodyA) }),
        svc.handleCallback('wechat', bodyB, { 'x-payment-signature': signMemoryCallback(bodyB) }),
      ]);

      // 恰一个 fulfilled，另一个 rejected（PAYMENT_TRADE_CONFLICT），无未处理异常。
      const kinds = [ra.kind, rb.kind].sort();
      expect(kinds).toEqual(['fulfilled', 'rejected']);
      const rejectedOne = (ra.kind === 'rejected' ? ra : rb) as { code: string };
      expect(rejectedOne.code).toBe('PAYMENT_TRADE_CONFLICT');

      // 仅一条 success 流水。
      const [paymentRows] = await pool.query(
        'SELECT order_id, result FROM payments WHERE channel = ? AND channel_trade_no = ?',
        ['wechat', tradeNo],
      );
      const successCount = (paymentRows as any[]).filter((p) => p.result === 'success').length;
      expect(successCount).toBe(1);
    } finally {
      await pool.end();
    }
  });
});