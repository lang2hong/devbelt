import type { FastifyInstance, FastifyRequest } from 'fastify';
import { registerConsoleErrorHandler } from '../../../middleware/consoleError.js';
import type { OrderService } from '../service/paymentService.js';
import type { PaymentChannel } from '../../../domain/enums.js';
import { FeatureTemporarilyDisabledError, PaymentSignatureInvalidError, PaymentCallbackInvalidError } from '../../../domain/errors.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import { PAYMENT_CHANNELS } from '../service/paymentChannel.js';

/**
 * 支付回调公开路由（P4 §金额与安全）：
 * - 不依赖 session/cookie，走渠道签名校验（由 OrderService 内部验签）；
 * - 验签必须基于**原始请求字节**：本插件作用域注册 raw-body content-type parser，
 *   `req.body` 即未重编码的原始明文，先验签、后由渠道适配器解析；
 * - 入口按 IP 限流（防伪造回调审计洪流）；
 * - 验签通过后的领域失败回 200 rejected（止渠道重试），仅验签失败为 4xx。
 */
export interface PaymentCallbackRouteOptions {
  orderService: OrderService;
  auditWriter: AuditWriter;
  rateLimiter: RateLimitService;
  /** 支付功能开关（§11.4）。关闭时回调返回 503 FEATURE_TEMPORARILY_DISABLED。 */
  paymentFeatureEnabled?: () => boolean;
  /** 该渠道是否已配置（未配置 → 503，而非落 generic 异常）。 */
  channelConfigured?: (channel: PaymentChannel) => boolean;
  /**
   * 是否转发测试 stub 签名头 `x-payment-signature`。默认 false（生产不转发；
   * 真渠道不发该头，内存 stub 网关的测试组合显式开启）。
   */
  allowStubSignature?: boolean;
}

/** 各渠道回调验签所需的标准化头转发白名单（验签输入，不外泄无关头）。 */
const CHANNEL_HEADERS: Readonly<Record<PaymentChannel, readonly string[]>> = {
  wechat: ['wechatpay-timestamp', 'wechatpay-nonce', 'wechatpay-signature', 'wechatpay-serial'],
  alipay: [],
};

function requestIdOf(req: FastifyRequest): string {
  return (req as unknown as { requestId?: string }).requestId ?? 'unknown';
}

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

export async function paymentCallbackRoutes(app: FastifyInstance, opts: PaymentCallbackRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  // 保留原始请求字节：签名验证的是「恰如渠道发送」的字节，任何 JSON 重解析或逐 chunk
  // UTF-8 解码都会改变内容（多字节字符可能跨 chunk 边界产生替换字符）。此处用
  // Buffer[] + Buffer.concat 严格保留字节，验签输入为 Buffer。
  for (const ct of ['application/json', 'text/plain', 'application/xml', 'text/xml', 'application/x-www-form-urlencoded']) {
    app.addContentTypeParser(ct, (_req, payload, done) => {
      const chunks: Buffer[] = [];
      payload.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      payload.on('end', () => done(null, Buffer.concat(chunks)));
      payload.on('error', (err: Error) => done(err));
    });
  }

  app.post('/api/db/public/payment-callback/:channel', async (req, reply) => {
    if (opts.paymentFeatureEnabled && !opts.paymentFeatureEnabled()) {
      throw new FeatureTemporarilyDisabledError('payment');
    }
    const channel = (req.params as Record<string, unknown>).channel;
    if (typeof channel !== 'string' || !(PAYMENT_CHANNELS as readonly string[]).includes(channel)) {
      return reply.code(400).send({ error: { code: 'UNKNOWN_CHANNEL', message: 'unsupported payment channel' } });
    }
    // 渠道未配置 → 显式 fail-closed 503，而非落 generic 异常。
    if (opts.channelConfigured && !opts.channelConfigured(channel as PaymentChannel)) {
      throw new FeatureTemporarilyDisabledError('payment');
    }

    // 入口 IP 限流：验签靠后，但伪造回调必须被廉价限流挡住。
    await opts.rateLimiter.hit(`payment:callback:ip:${req.ip ?? 'unknown'}`, 60, 120);

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // 按渠道转发验签所需标准头（微信 v3 头；支付宝回调签名在表单内，无额外头）。
    // 另保留 x-payment-signature 给内存测试 stub 使用（真实渠道不发送、生产无害）。
    const headers: Record<string, string> = {};
    for (const name of CHANNEL_HEADERS[channel as PaymentChannel]) {
      const v = headerOf(req, name);
      if (v !== undefined) headers[name] = v;
    }
    // 另保留 x-payment-signature 给内存测试 stub 使用；仅在显式开启时转发，
    // 生产组合默认关闭（真渠道不发送、也不引入多余可伪造面）。
    if (opts.allowStubSignature === true) {
      const stubSig = headerOf(req, 'x-payment-signature');
      if (stubSig !== undefined) headers['x-payment-signature'] = stubSig;
    }

    let outcome;
    try {
      outcome = await opts.orderService.handleCallback(channel as PaymentChannel, rawBody, headers);
    } catch (e) {
      // P1-A：验签失败等 thrown 路径也要审计（保持审计断流不回归）。
      opts.auditWriter.write({
        eventType: 'payment.callback.failed',
        result: 'failure',
        failureCode: e instanceof PaymentSignatureInvalidError ? 'PAYMENT_SIGNATURE_INVALID'
          : e instanceof PaymentCallbackInvalidError ? 'PAYMENT_CALLBACK_INVALID' : null,
        sourceIp: req.ip,
        requestId: requestIdOf(req),
      });
      throw e;
    }
    if (outcome.kind === 'rejected') {
      opts.auditWriter.write({
        eventType: 'payment.callback.failed',
        result: 'failure',
        failureCode: outcome.code,
        sourceIp: req.ip,
        requestId: requestIdOf(req),
      });
      // 验签已通过、领域侧拒绝：返回渠道专属确认以终止重试（支付宝需纯文本 success）。
      return ackChannel(reply, channel as PaymentChannel);
    }
    return ackChannel(reply, channel as PaymentChannel);
  });
}

/** 渠道专属回调确认：支付宝异步通知要求字面 `success`（text/plain）；微信 v3 用 JSON ack。 */
function ackChannel(reply: { type(v: string): unknown; code(n: number): unknown; send(b: unknown): unknown }, channel: PaymentChannel): unknown {
  if (channel === 'alipay') {
    reply.type('text/plain');
    reply.code(200);
    return reply.send('success');
  }
  reply.code(200);
  return reply.send({ code: 'SUCCESS', message: '成功' });
}