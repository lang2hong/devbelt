import { describe, it, expect } from 'vitest';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';
import { MysqlOrderRepo } from '../../src/repository/mysql/orderRepo.js';
import { MysqlInvoiceRepo } from '../../src/repository/mysql/invoiceRepo.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';
import { MysqlPersonalPlanRepo } from '../../src/repository/mysql/personalPlanRepo.js';
import { MysqlPersonalSubscriptionRepo } from '../../src/repository/mysql/personalSubscriptionRepo.js';
import { InvoiceService } from '../../src/service/invoiceService.js';
import { InvoiceAlreadyRequestedError } from '../../src/domain/errors.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';
import { withTransaction } from '../../src/repository/mysql/db.js';

const URL = process.env.MYSQL_TEST_URL;

async function makeUser(db: MysqlDb): Promise<number> {
  const userRepo = new MysqlUserRepo(() => db);
  const user = await userRepo.create(`inv-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`, 'hash', 'INV');
  const planRepo = new MysqlPersonalPlanRepo(() => db);
  const subRepo = new MysqlPersonalSubscriptionRepo(() => db);
  const plan = await planRepo.findByCode('free');
  await subRepo.create({ userId: user.id, planId: plan!.id, status: 'active', entitlementSnapshot: {}, periodStartTime: new Date(), periodEndTime: null });
  return user.id;
}

describe.skipIf(!URL)('invoice order-unique concurrency (real MySQL)', () => {
  it('two concurrent requests for the same order (different idempotency keys) yield one invoice', async () => {
    const pool = createTestPool();
    await runMigrations(pool as unknown as MysqlDb, [...migrations]);
    const db = pool as unknown as MysqlDb;
    try {
      const userId = await makeUser(db);
      const orderRepo = new MysqlOrderRepo(() => db);
      const invoiceRepo = new MysqlInvoiceRepo(() => db);
      const svc = new InvoiceService({
        invoiceRepo,
        orderRepo,
        auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as never),
      });

      // 一个已履约订单（直接写库，绕过支付流程）。
      const order = await orderRepo.create({ orderNo: `ord-${Date.now()}-${Math.random().toString(16).slice(2)}`, userId, planCode: 'pro', amountCents: 9900, channel: 'wechat', expiresTime: new Date(Date.now() + 60000) });
      await withTransaction(db, async (tx) => {
        await orderRepo.advance(tx, { id: order.id, expectedStatus: 'pending', status: 'paid', channelTradeNo: 'wx-t', paidTime: new Date() });
      });
      await withTransaction(db, async (tx) => {
        await orderRepo.advance(tx, { id: order.id, expectedStatus: 'paid', status: 'fulfilled', channelTradeNo: null, paidTime: null });
      });

      const apply = () => svc.requestInvoiceInTx({} as never, userId, { orderNo: order.orderNo, title: 'Acme', email: 'billing@a.com' });
      // 用 withTransaction 包裹两次并发申请（不同幂等键在路由层，事务层等价于此并发语义）。
      const run = () => withTransaction(db, (tx) => svc.requestInvoiceInTx(tx, userId, { orderNo: order.orderNo, title: 'Acme', email: 'billing@a.com' }));

      const results = await Promise.allSettled([run(), run()]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toBe(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvoiceAlreadyRequestedError);

      const invoices = await invoiceRepo.listByUser(userId, undefined, 10);
      expect(invoices).toHaveLength(1);
      void apply;
    } finally {
      await pool.end();
    }
  });
});