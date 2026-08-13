import type { FastifyInstance } from 'fastify';
import { sendError } from '../middleware/errorHandler.js';
import type { PaymentService } from '../service/paymentService.js';
import type { PaymentProvider as ProviderName } from '../domain/enums.js';

export interface WebhookRouteOptions {
  paymentService: PaymentService;
}

/**
 * 支付回调路由：公开（签名校验由适配器内部完成）。
 * POST /webhook/payment/:provider  body=原始载荷, header x-signature=签名
 *
 * MVP 仅 manual（无 webhook）；接 Stripe/LemonSqueezy 时适配器实现验签。
 * 注：生产需 @fastify/raw-body 获取原始字节验签，此处用 JSON.stringify 预留。
 */
export async function webhookRoutes(app: FastifyInstance, opts: WebhookRouteOptions): Promise<void> {
  app.post('/webhook/payment/:provider', async (req, reply) => {
    const provider = (req.params as any).provider as ProviderName;
    const signature = req.headers['x-signature'] as string | undefined;
    try {
      const payload = Buffer.from(JSON.stringify(req.body));
      await opts.paymentService.handleWebhook(provider, payload, signature);
      reply.send({ received: true });
    } catch (e) {
      sendError(reply, e);
    }
  });
}
