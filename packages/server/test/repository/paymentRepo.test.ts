import { describe, it, expect } from 'vitest';
import { MysqlOrderRepo } from '../../src/repository/mysql/orderRepo.js';
import { MysqlPaymentRepo } from '../../src/repository/mysql/paymentRepo.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

/**
 * 支付持久化不变量（P4 切片 1）：
 * - `payment.create` 的 INSERT 与回读都在调用方传入的 `exec` 上（事务同一条连接），
 *   绝不回读走池 getter —— 未提交事务对池内其它连接不可见，会拿 undefined 且
 *   二次借连接可能死锁（db.ts 契约）。
 * - `order.advance` 的 WHERE 同时带 id 与 expectedStatus（CAS），0 行 → false。
 */
function makeDb() {
  const poolQueries: Array<{ sql: string; params?: any[] }> = [];
  const db: MysqlDb = {
    database: 'test',
    query: async <T = any>(sql: string, params?: any[]): Promise<T> => {
      poolQueries.push({ sql, params });
      return [[], undefined] as unknown as T;
    },
    getConnection: async () => ({
      query: async () => [[], undefined] as any,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    }),
  };
  return { db, poolQueries };
}

const PAYMENT_ROW = {
  id: 1,
  order_id: 9,
  channel: 'wechat',
  channel_trade_no: 'wx-trade-1',
  amount_cents: 9900,
  raw_notification: null,
  signature_verified: 1,
  result: 'success',
  create_time: '2026-09-10T00:00:00.000Z',
};

describe('payment repo transaction boundary', () => {
  it('create runs INSERT and read-back on the passed exec, never the pool', async () => {
    const { poolQueries } = makeDb();
    const seen: string[] = [];
    const scriptedExec = {
      query: async <T = any>(sql: string, _params?: any[]): Promise<T> => {
        seen.push(sql);
        if (seen.length === 1) return [{ insertId: 1 }, undefined] as unknown as T;
        return [[PAYMENT_ROW], undefined] as unknown as T;
      },
    };

    const repo = new MysqlPaymentRepo();
    const created = await repo.create(scriptedExec, {
      orderId: 9,
      channel: 'wechat',
      channelTradeNo: 'wx-trade-1',
      amountCents: 9900,
      rawNotification: null,
      signatureVerified: true,
      result: 'success',
    });

    expect(created.id).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^INSERT INTO payments/);
    expect(seen[1]).toMatch(/^SELECT \* FROM payments WHERE id = \?/);
    // 池 getter 全程未被触碰（无构造函数池注入，也无回读走池）。
    expect(poolQueries).toHaveLength(0);
  });
});

describe('order advance CAS primitive', () => {
  it('advance returns false when affectedRows is 0', async () => {
    const repo = new MysqlOrderRepo(() => makeDb().db);
    const ok = await repo.advance(
      { query: async () => [{ affectedRows: 0 }, undefined] as any },
      {
        id: 5,
        expectedStatus: 'pending',
        status: 'paid',
        channelTradeNo: 'wx-trade-1',
        paidTime: new Date('2026-09-10T00:00:00.000Z'),
      },
    );
    expect(ok).toBe(false);
  });

  it('advance returns true and guards with both id and expectedStatus', async () => {
    let capturedSql = '';
    let capturedParams: any[] = [];
    const repo = new MysqlOrderRepo(() => makeDb().db);
    const ok = await repo.advance(
      {
        query: async (sql: string, params?: any[]): Promise<any> => {
          capturedSql = sql;
          capturedParams = params ?? [];
          return [{ affectedRows: 1 }, undefined];
        },
      },
      {
        id: 5,
        expectedStatus: 'pending',
        status: 'paid',
        channelTradeNo: 'wx-trade-1',
        paidTime: new Date('2026-09-10T00:00:00.000Z'),
      },
    );
    expect(ok).toBe(true);
    expect(capturedSql).toMatch(/WHERE id = \? AND status = \?/);
    expect(capturedParams).toContain(5);
    expect(capturedParams).toContain('pending');
  });
});

describe('payment channel_trade_no uniqueness metadata', () => {
  it('create SQL captures all idempotency-relevant columns', async () => {
    let capturedSql = '';
    let capturedParams: any[] = [];
    const repo = new MysqlPaymentRepo();
    await repo.create(
      {
        query: async (sql: string, params?: any[]): Promise<any> => {
          if (sql.startsWith('INSERT')) {
            capturedSql = sql;
            capturedParams = params ?? [];
            return [{ insertId: 1 }, undefined];
          }
          return [[PAYMENT_ROW], undefined];
        },
      },
      {
        orderId: 9,
        channel: 'wechat',
        channelTradeNo: 'wx-trade-1',
        amountCents: 9900,
        rawNotification: null,
        signatureVerified: false,
        result: 'failure',
      },
    );
    expect(capturedSql).toContain('channel_trade_no');
    expect(capturedParams).toContain('wx-trade-1');
    expect(capturedParams).toContain(0); // signature_verified=false → 0
  });
});