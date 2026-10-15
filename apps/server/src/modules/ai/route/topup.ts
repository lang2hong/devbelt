import type { FastifyInstance, FastifyRequest } from 'fastify';
import { consoleSession, type GetAuthUser } from '../../../middleware/requireAuth.js';
import { registerConsoleErrorHandler, rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { CsrfService } from '../../../service/csrfService.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import type { AiTopupService } from '../service/aiTopupService.js';
import type { AiTopupOrder } from '../repository/aiTopupRepo.js';
import type { PaymentGateway, PrepayParams } from '../../billing/service/paymentChannel.js';
import type { PaymentChannel } from '../../../domain/enums.js';
import { PAYMENT_CHANNELS, clientPayParams } from '../../billing/service/paymentChannel.js';
import { FeatureTemporarilyDisabledError, ValidationError } from '../../../domain/errors.js';

/**
 * 用户侧加油包下单路由（P9.1c，console-only；复用 P4 收银台）。
 *
 * 与 P4 `POST /api/db/console/orders` 同口径：
 * - 下单**不用 Idempotency-Key 回执**（prepay 是事务外、不可幂等重放的外部副作用；
 *   多建 pending 无害——只有被回调的那一单会 paid，其余自然过期）；
 * - 支付功能开关 / 渠道配置 fail-closed（503 FEATURE_TEMPORARILY_DISABLED）；
 * - 金额以库内 SKU 为准，不接受前端金额；CSRF 写守卫 + 下单限流 10/h。
 * 订单状态轮询复用 `GET /api/db/console/orders/:orderNo`（不新增端点）。
 */
export interface AiTopupOrderRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  rateLimiter: RateLimitService;
  topup: AiTopupService;
  auditWriter: AuditWriter;
  /** 支付功能开关（关闭 → 503）。 */
  paymentFeatureEnabled: () => boolean;
  /** 该渠道是否已配置（未配置 → 503，而非 generic 异常）。 */
  channelConfigured: (channel: PaymentChannel) => boolean;
  /** 渠道适配器工厂（app 组合根注入 resolvePaymentGateway）。 */
  gatewayFor: (channel: PaymentChannel) => PaymentGateway;
  /** 连接池执行器（单条 INSERT 直写，非事务）。 */
  exec: { query(sql: string, params?: unknown[]): Promise<unknown> };
}

function userIdOf(req: FastifyRequest): number {
  return (req as unknown as { authUserId: number }).authUserId;
}

function topupOrderDto(o: AiTopupOrder) {
  return {
    orderNo: o.orderNo,
    userId: o.userId,
    purpose: 'topup' as const,
    planCode: null,
    skuCode: o.skuCode,
    amountCents: o.amountCents,
    channel: o.channel,
    status: o.status,
    paidTime: null,
    expiresTime: o.expiresTime.toISOString(),
    createTime: o.expiresTime.toISOString(),
  };
}

export async function aiTopupOrderRoutes(app: FastifyInstance, opts: AiTopupOrderRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  await app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    routes: async (child) => {
      child.post('/api/ai/topup-orders', { schema: { body: createTopupOrderBody } }, async (req, reply) => {
        if (!opts.paymentFeatureEnabled()) throw new FeatureTemporarilyDisabledError('payment');
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
          return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        }
        const actor = userIdOf(req);
        // 下单低频高危面：10 次/小时（对齐 P4 套餐下单）。
        await opts.rateLimiter.hit(`console:ai-topup:create:${actor}`, 3600, 10);
        const { skuCode, channel, mode } = req.body as { skuCode: string; channel: string; mode?: 'qr' | 'redirect' };
        const ch = parseChannel(channel);
        if (!opts.channelConfigured(ch)) throw new FeatureTemporarilyDisabledError('payment');
        const { order, payParams } = await opts.topup.createChannelOrder(
          { userId: actor, skuCode, channel: ch, mode },
          {
            exec: opts.exec as never,
            gatewayFor: opts.gatewayFor,
            expiresMs: 30 * 60 * 1000,
            minLifetimeMs: 60 * 1000,
            auditWrite: (orderNo) =>
              opts.auditWriter.write({
                eventType: 'payment.order.created',
                result: 'success',
                actorUserId: actor,
                targetType: 'order',
                targetId: orderNo,
              }),
          },
        );
        reply.code(201).send({ order: topupOrderDto(order), payParams: clientPayParams(payParams) });
      });
    },
  });
}

function parseChannel(raw: unknown): PaymentChannel {
  if (typeof raw !== 'string' || !(PAYMENT_CHANNELS as readonly string[]).includes(raw)) {
    throw new ValidationError('unsupported payment channel');
  }
  return raw as PaymentChannel;
}

const createTopupOrderBody = {
  type: 'object',
  required: ['skuCode', 'channel'],
  additionalProperties: false,
  properties: {
    skuCode: { type: 'string', minLength: 1, maxLength: 32 },
    channel: { type: 'string', enum: [...PAYMENT_CHANNELS] },
    /** 支付方式：扫码(qr) / 跳转(redirect)。缺省按渠道（微信扫码、支付宝跳转）。 */
    mode: { type: 'string', enum: ['qr', 'redirect'] },
  },
} as const;

export type { PrepayParams };
