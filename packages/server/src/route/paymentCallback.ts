import type { FastifyInstance, FastifyRequest } from 'fastify';
import { registerConsoleErrorHandler } from '../middleware/consoleError.js';
import type { OrderService } from '../service/paymentService.js';
import type { PaymentChannel } from '../domain/enums.js';
import { PaymentSignatureInvalidError } from '../domain/errors.js';
import type { AuditWriter } from '../service/auditWriter.js';
import type { RateLimitService } from '../service/rateLimitService.js';
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
}

function requestIdOf(req: FastifyRequest): string {
  return (req as unknown as { requestId?: string }).requestId ?? 'unknown';
}

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

export async function paymentCallbackRoutes(app: FastifyInstance, opts: PaymentCallbackRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

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

  app.post('/api/public/payment-callback/:channel', async (req, reply) => {
    const channel = (req.params as Record<string, unknown>).channel;
    if (typeof channel !== 'string' || !(PAYMENT_CHANNELS as readonly string[]).includes(channel)) {
      return reply.code(400).send({ error: { code: 'UNKNOWN_CHANNEL', message: 'unsupported payment channel' } });
    }

    // 入口 IP 限流：验签靠后，但伪造回调必须被廉价限流挡住。
    await opts.rateLimiter.hit(`payment:callback:ip:${req.ip ?? 'unknown'}`, 60, 120);

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers = {
      'x-payment-signature': headerOf(req, 'x-payment-signature'),
    } as Record<string, string>;

    let outcome;
    try {
      outcome = await opts.orderService.handleCallback(channel as PaymentChannel, rawBody, headers);
    } catch (e) {
      // P1-A：验签失败等 thrown 路径也要审计（保持审计断流不回归）。
      opts.auditWriter.write({
        eventType: 'payment.callback.failed',
        result: 'failure',
        failureCode: e instanceof PaymentSignatureInvalidError ? 'PAYMENT_SIGNATURE_INVALID' : null,
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
      // 验签已通过、领域侧拒绝：200 终止渠道重试，不再重打。
      return reply.code(200).send({ ok: true, status: 'rejected', code: outcome.code });
    }
    reply.code(200).send({ ok: true, status: outcome.kind });
  });
}