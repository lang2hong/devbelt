import type { FastifyInstance } from 'fastify';
import { sendError } from '../middleware/errorHandler.js';
import type { PaymentService } from '../service/paymentService.js';
import type { PaymentProvider as ProviderName } from '../domain/enums.js';
import { providerParam } from './schemas.js';

export interface WebhookRouteOptions {
  paymentService: PaymentService;
}

/**
 * 支付回调路由：公开（签名校验由适配器内部完成）。
 * POST /webhook/payment/:provider  body=原始载荷, header x-signature=签名
 *
 * ## 为什么必须拿原始字节
 *
 * 原实现传给适配器的是 `Buffer.from(JSON.stringify(req.body))` —— 把 Fastify
 * 解析后的对象**重新序列化**。而 HMAC 是逐字节算的，重建出来的 JSON 几乎不可能
 * 与支付商发出的原文一致：键顺序、空白、Unicode 转义、数字表示（`1e3` vs `1000`）、
 * 浮点精度，任意一项不同签名就不匹配。也就是说验签在结构上不可能通过 ——
 * 接任何真实支付商都会 100% 拒绝所有合法回调。
 *
 * ## 实现方式：作用域内的 content-type parser，不引第三方依赖
 *
 * Fastify 的 `addContentTypeParser` 遵循插件封装边界，在本插件里注册只影响
 * 本作用域的路由，不会波及 `/api/*`（那些仍走默认 JSON 解析）。用
 * `parseAs: 'buffer'` 拿到原始字节，挂到 `req.rawBody` 后自己 `JSON.parse`，
 * 于是既有原文可验签、又保留了 `req.body` 的对象形态。
 *
 * 这比引 `@fastify/raw-body` 少一个依赖，行为也更明确 —— 那个插件默认全局生效，
 * 会给所有路由多留一份 body 副本。
 */
export async function webhookRoutes(app: FastifyInstance, opts: WebhookRouteOptions): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      const raw = body as Buffer;
      // 原文挂到 request 上 —— 这是整件事的目的：让 handler 拿到未经往返的字节
      req.rawBody = raw;
      // 空 body：交给下游按「无载荷」处理，不在这里造一个假对象
      if (raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw.toString('utf8')));
      } catch {
        // 非法 JSON → 400。errorHandler 会把它归到 VALIDATION_ERROR
        const err = new Error('invalid JSON payload') as Error & { statusCode: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  app.post('/webhook/payment/:provider', { schema: { params: providerParam } }, async (req, reply) => {
    const provider = (req.params as any).provider as ProviderName;
    const signature = req.headers['x-signature'] as string | undefined;
    try {
      // 原始字节，不是 req.body 重新序列化的结果 —— 见上文
      const payload = rawBodyOf(req);
      await opts.paymentService.handleWebhook(provider, payload, signature);
      reply.send({ received: true });
    } catch (e) {
      sendError(reply, e);
    }
  });
}

/**
 * 取原始请求体。
 *
 * parser 只对有 body 的请求跑，所以 rawBody 可能缺失（比如 content-type 不是
 * application/json，或者根本没带 body）。这时给空 Buffer 而不是回退到
 * `JSON.stringify(req.body)` —— 后者正是本次要消除的错误来源，留着它等于留一条
 * 静默产生错签名的路。空 Buffer 会让适配器的验签明确失败，这是想要的行为。
 */
function rawBodyOf(req: { rawBody?: Buffer }): Buffer {
  return req.rawBody ?? Buffer.alloc(0);
}

declare module 'fastify' {
  interface FastifyRequest {
    /** webhook 作用域内的原始请求体字节（供 HMAC 验签） */
    rawBody?: Buffer;
  }
}
