import { describe, it, expect } from 'vitest';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import { MysqlOrderRepo } from '../../src/repository/mysql/orderRepo.js';
import { MysqlPaymentRepo } from '../../src/repository/mysql/paymentRepo.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';
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
          rawNotification: '{}',
          signatureVerified: true,
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
          rawNotification: '{}',
          signatureVerified: true,
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
            rawNotification: '{}',
            signatureVerified: true,
            result: 'success',
          });
        }),
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});