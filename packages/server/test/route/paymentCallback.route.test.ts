import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { Readable } from 'stream';
import { paymentCallbackRoutes } from '../../src/route/paymentCallback.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { OrderService } from '../../src/service/paymentService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { signMemoryCallback } from '../../src/service/paymentChannel.js';
import type { PaymentGateway, PaymentCallback, PrepayParams } from '../../src/service/paymentChannel.js';
import type { PaymentChannel } from '../../src/domain/enums.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import type { Order, Payment, PersonalPlan, PersonalSubscription } from '../../src/domain/entities.js';

/**
 * 回调路由 raw-body parser 的字节保真（P4 P2）：证明「经 Fastify content-type parser」
 * 后，gateway 收到的 Buffer 与请求原始字节完全一致——含跨 chunk 的多字节 UTF-8。
 * 与 service 级手工 Buffer.concat 测试互补：那测试只证明 Node Buffer；本测试证明路由层。
 */

const PLAN: PersonalPlan = {
  id: 2, code: 'pro', name: 'Pro',
  allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'],
  maxDevices: 0, maxConnectionMetas: 5000, syncStorageBytes: 268435456,
  maxSavedConnections: 100, allowConnectionImport: true,
  status: 'active', createTime: new Date(), updateTime: new Date(),
};

class CaptureGateway implements PaymentGateway {
  readonly channel: PaymentChannel;
  captured: Buffer | undefined;
  constructor(channel: PaymentChannel) { this.channel = channel; }
  async createPayment(_i: { orderNo: string; amountCents: number }): Promise<PrepayParams> { return {}; }
  verifyCallback(rawBody: Buffer): boolean { this.captured = rawBody; return true; }
  parseCallback(rawBody: Buffer): PaymentCallback { return JSON.parse(rawBody.toString('utf8')) as PaymentCallback; }
}

const noopOrderRepo = {
  findByOrderNoForUpdate: async (_t: Queryable) => undefined,
  findPendingByUserAndPlan: async () => undefined,
  listByUser: async () => [],
  findByOrderNo: async () => undefined,
  create: async () => ({} as Order),
  advance: async () => false,
};
const noopPaymentRepo = {
  findByChannelTradeNo: async () => undefined,
  create: async () => ({} as Payment),
};
const noopPlanRepo = { findByCodeInTx: async () => PLAN, findByCode: async () => PLAN, findById: async () => PLAN };
const noopSubRepo = {
  findByUserIdForUpdate: async () => undefined,
  findByUserId: async () => undefined,
  findByUserIdInTx: async () => undefined,
  create: async () => ({} as PersonalSubscription),
  update: async () => true,
};

async function build(gateway: PaymentGateway) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);
  const orderService = new OrderService({
    orderRepo: noopOrderRepo as never,
    paymentRepo: noopPaymentRepo as never,
    personalPlanRepo: noopPlanRepo as never,
    personalSubscriptionRepo: noopSubRepo as never,
    auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as never),
    runner: async (fn) => fn({} as Queryable),
    gatewayFor: () => gateway,
  });
  await app.register(paymentCallbackRoutes, {
    orderService,
    auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as never),
    rateLimiter: new RateLimitService({ increment: async () => 1, peek: async () => 0 } as never, false),
  });
  await app.ready();
  return app;
}

describe('payment callback route raw bytes', () => {
  it('delivers the exact original bytes (with multibyte UTF-8) to the gateway', async () => {
    const gateway = new CaptureGateway('wechat');
    const app = await build(gateway);

    // 包含多字节汉字 + emoji 的原始 JSON，与 JSON.stringify 输出不同（字段顺序/空白）。
    const raw = Buffer.from('{  "orderNo":"ord1","channelTradeNo":"wx-1","amountCents":9900,"status":"success","note":"支付成功💳" }');
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/payment-callback/wechat',
      headers: { 'content-type': 'application/json', 'x-payment-signature': signMemoryCallback(raw) },
      payload: raw,
    });

    expect(res.statusCode).toBe(200);
    expect(gateway.captured).toBeDefined();
    expect(gateway.captured!.equals(raw)).toBe(true);

    await app.close();
  });

  it('reassembles a multibyte UTF-8 character split across two request chunks', async () => {
    const gateway = new CaptureGateway('wechat');
    const app = await build(gateway);

    // 「成」的 UTF-8 编码是 E6 88 90 三字节；在 E6 88 | 90 处切开，使一个字符跨两个 chunk。
    const head = Buffer.from('{"orderNo":"ord1","channelTradeNo":"wx-1","amountCents":9900,"status":"success","note":"支');
    const mid = Buffer.from('\xe6\x88'); // 「成」的前两字节
    const tail = Buffer.from('\x90 工"}');
    const raw = Buffer.concat([head, mid, tail]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/payment-callback/wechat',
      headers: { 'content-type': 'application/json', 'x-payment-signature': signMemoryCallback(raw) },
      payload: Readable.from([head, mid, tail]),
    });

    expect(res.statusCode).toBe(200);
    expect(gateway.captured).toBeDefined();
    expect(gateway.captured!.equals(raw)).toBe(true);

    await app.close();
  });
});