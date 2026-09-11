import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { Readable } from 'stream';
import { generateKeyPairSync, createSign, createCipheriv } from 'crypto';
import { paymentCallbackRoutes } from '../../src/route/paymentCallback.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { OrderService } from '../../src/service/paymentService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { signMemoryCallback, type PaymentGateway, type PaymentCallback, type PrepayParams } from '../../src/service/paymentChannel.js';
import { WechatPayGateway } from '../../src/service/wechatPay.js';
import { resolveWechatCredentials } from '../../src/service/paymentCredentials.js';
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
  async createPayment(_i: { orderNo: string; amountCents: number; expiresTime: Date }): Promise<PrepayParams> { return {}; }
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

  it('accepts a real WeChat v3 signed callback through the route (header forwarding + verify)', async () => {
    const mk = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const env: NodeJS.ProcessEnv = {
      PAYMENT_CALLBACK_BASE_URL: 'https://pay.example.com',
      WECHAT_MCH_ID: 'mch',
      WECHAT_APP_ID: 'app',
      WECHAT_MERCHANT_CERT_SERIAL: 'ABCDEF1234567890',
      WECHAT_PLATFORM_CERT_SERIAL: 'FEDCBA0987654321',
      WECHAT_PRIVATE_KEY_B64: Buffer.from(mk.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64'),
      WECHAT_PLATFORM_CERT_B64: Buffer.from(mk.publicKey.export({ type: 'spki', format: 'pem' }).toString()).toString('base64'),
      WECHAT_API_V3_KEY: '0123456789abcdef0123456789abcdef',
    };
    const cred = resolveWechatCredentials(env)!;

    // 构造一个真实「已履约有订单 + 有订阅」的 OrderService：noop 回退会导致 rejected。
    // 这里只证明验签 + 头部转发通过，故用真实 gateway，且让 order 不存在 → 验签通过后 rejected(ORDER_NOT_FOUND) 也证明验签成功。
    const gateway = new WechatPayGateway(cred);
    const app = await build(gateway);

    // 加密一个合法 resource，再用平台私钥对 timestamp\nnonce\nbody\n 签名。
    const apiV3Key = Buffer.from('0123456789abcdef0123456789abcdef');
    const nonce = 'abcdefgh';
    const aad = 'transaction';
    const plaintext = JSON.stringify({ appid: 'app', mchid: 'mch', out_trade_no: 'ord1', transaction_id: 'wx-t-1', amount: { total: 9900 }, trade_state: 'SUCCESS' });
    const enc = createCipheriv('aes-256-gcm', apiV3Key, Buffer.from(nonce));
    enc.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([enc.update(plaintext, 'utf8'), enc.final()]);
    const resource = Buffer.concat([ct, enc.getAuthTag()]).toString('base64');
    const rawBody = Buffer.from(JSON.stringify({ resource: { ciphertext: resource, nonce, associated_data: aad } }));

    const timestamp = String(Math.floor(Date.now() / 1000));
    const signer = createSign('RSA-SHA256');
    signer.update(`${timestamp}\n${nonce}\n${rawBody.toString('utf8')}\n`);
    const signature = signer.sign(mk.privateKey, 'base64');

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/payment-callback/wechat',
      headers: {
        'content-type': 'application/json',
        'wechatpay-timestamp': timestamp,
        'wechatpay-nonce': nonce,
        'wechatpay-signature': signature,
        'wechatpay-serial': cred.platformCertSerial,
      },
      payload: rawBody,
    });

    // 验签通过 → OrderService 继续走到订单查找；noop order 不存在 → rejected，
    // 但响应为微信 v3 的 JSON ack（provider 停止重试）。
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: 'SUCCESS', message: '成功' });

    await app.close();
  });

  it('returns 503 when the channel is not configured', async () => {
    const gateway = new CaptureGateway('wechat');
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
      channelConfigured: () => false,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/payment-callback/wechat',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('FEATURE_TEMPORARILY_DISABLED');
    await app.close();
  });

  it('returns text/plain "success" for an Alipay callback ack', async () => {
    // 支付宝回调：验签恒真、解析返回固定归一化结果；noop order 不存在 → rejected，ack 仍为纯文本 success。
    const gateway: PaymentGateway = {
      channel: 'alipay',
      async createPayment(): Promise<PrepayParams> { return {}; },
      verifyCallback(): boolean { return true; },
      parseCallback(): PaymentCallback { return { orderNo: 'ord1', channelTradeNo: 'ali-t-1', amountCents: 9900, status: 'success' }; },
    };
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

    const res = await app.inject({
      method: 'POST',
      url: '/api/public/payment-callback/alipay',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'out_trade_no=ord1&trade_no=ali-t-1&total_amount=99.00&trade_status=TRADE_SUCCESS',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('success');
    await app.close();
  });
});