import type { FastifyInstance, FastifyRequest } from 'fastify';
import { consoleSession, type GetAuthUser } from '../../../middleware/requireAuth.js';
import { registerConsoleErrorHandler, rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import type { OrderService } from '../service/paymentService.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { CsrfService } from '../../../service/csrfService.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { CursorService } from '../../../service/cursor.js';
import type { Order } from '../../../domain/entities.js';
import { FeatureTemporarilyDisabledError, ValidationError } from '../../../domain/errors.js';
import { PAYMENT_CHANNELS, clientPayParams } from '../service/paymentChannel.js';

/**
 * 支付订单路由（P4 切片 2，console-only）。
 *
 * 下单刻意**不用 Idempotency-Key + 回执事务**：下单含「渠道预下单」这一事务外、不可
 * 幂等重放的外部副作用（微信/支付宝 prepay），把它塞进回执事务等于在事务内发起外部
 * HTTP 调用（违反 db.ts 契约）；而「多建一个 pending 订单」本身无害（只有被回调的
 * 那一单会 paid，其余自然过期）。资金安全口径在**回调**端：那边是严格幂等
 * （channel_trade_no 唯一 + 订单 CAS），不需要回执。
 */
export interface OrdersRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  rateLimiter: RateLimitService;
  cursorService: CursorService;
  orderService: OrderService;
  /** 支付功能开关（§11.4）。关闭时下单返回 503 FEATURE_TEMPORARILY_DISABLED。 */
  paymentFeatureEnabled?: () => boolean;
  /** 该渠道是否已配置（未配置 → 503，而非落 generic 异常）。 */
  channelConfigured?: (channel: (typeof PAYMENT_CHANNELS)[number]) => boolean;
}

function userIdOf(req: FastifyRequest): number {
  return (req as unknown as { authUserId: number }).authUserId;
}

function orderDto(order: Order) {
  return {
    orderNo: order.orderNo,
    planCode: order.planCode,
    amountCents: order.amountCents,
    channel: order.channel,
    status: order.status,
    paidTime: order.paidTime ? order.paidTime.toISOString() : null,
    expiresTime: order.expiresTime.toISOString(),
    createTime: order.createTime.toISOString(),
  };
}

function parseChannel(raw: unknown): (typeof PAYMENT_CHANNELS)[number] {
  if (typeof raw !== 'string' || !(PAYMENT_CHANNELS as readonly string[]).includes(raw)) {
    throw new ValidationError('unsupported payment channel');
  }
  return raw as (typeof PAYMENT_CHANNELS)[number];
}

function parseCursor(cursorService: CursorService, raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return undefined;
  const decoded = cursorService.decode(raw);
  if (decoded === null) return undefined;
  const n = Number(decoded);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : 50;
  if (!Number.isInteger(n) || n <= 0) return 50;
  return Math.min(n, 100);
}

/** 支付订单只读路由（P4 切片 3）：恒注册（无资金面风险）。列表/详情 = 限流读。 */
export async function ordersReadRoutes(app: FastifyInstance, opts: OrdersRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);
  const svc = opts.orderService;

  await app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    routes: async (child) => {
      child.get('/api/db/console/orders', async (req, reply) => {
        const actor = userIdOf(req);
        await opts.rateLimiter.hit(`console:order:read:${actor}`, 60, 60);
        const q = req.query as Record<string, unknown>;
        const cursor = parseCursor(opts.cursorService, q.cursor);
        if (q.cursor !== undefined && q.cursor !== '' && cursor === undefined) {
          return rejectConsole(reply, 422, 'INVALID_CURSOR', 'invalid cursor');
        }
        const limit = parseLimit(q.limit);
        const orders = await svc.listOrders(actor, cursor, limit + 1);
        const hasMore = orders.length > limit;
        const items = hasMore ? orders.slice(0, limit) : orders;
        reply.send({
          items: items.map(orderDto),
          nextCursor: hasMore && items.length ? opts.cursorService.encode(String(items[items.length - 1].id)) : null,
        });
      });

      child.get('/api/db/console/orders/:orderNo', async (req, reply) => {
        const actor = userIdOf(req);
        await opts.rateLimiter.hit(`console:order:read:${actor}`, 60, 60);
        const orderNo = (req.params as Record<string, unknown>).orderNo;
        if (typeof orderNo !== 'string' || !orderNo) return rejectConsole(reply, 404, 'ORDER_NOT_FOUND', 'order not found');
        const order = await svc.getOrder(actor, orderNo);
        reply.send(orderDto(order));
      });
    },
  });
}

/** 支付订单写路由（下单，P4 切片 2）：仅在支付网关配置后注册（受 `paymentEnabled` 门禁）。 */
export async function ordersWriteRoutes(app: FastifyInstance, opts: OrdersRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);
  const svc = opts.orderService;

  await app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    routes: async (child) => {
      child.post('/api/db/console/orders', { schema: { body: createOrderBody } }, async (req, reply) => {
        if (opts.paymentFeatureEnabled && !opts.paymentFeatureEnabled()) {
          throw new FeatureTemporarilyDisabledError('payment');
        }
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
          return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        }
        const actor = userIdOf(req);
        await opts.rateLimiter.hit(`console:order:create:${actor}`, 3600, 10);
        const { planCode, channel, mode } = req.body as { planCode: string; channel: string; mode?: 'qr' | 'redirect' };
        const ch = parseChannel(channel);
        if (opts.channelConfigured && !opts.channelConfigured(ch)) {
          throw new FeatureTemporarilyDisabledError('payment');
        }
        const r = await svc.createOrder(actor, planCode, ch, mode);
        const order = await svc.getOrder(actor, r.orderNo);
        reply.code(201).send({ order: orderDto(order), payParams: clientPayParams(r.payParams) });
      });
    },
  });
}

const createOrderBody = {
  type: 'object',
  required: ['planCode', 'channel'],
  additionalProperties: false,
  properties: {
    planCode: { type: 'string', minLength: 1, maxLength: 32 },
    channel: { type: 'string', enum: [...PAYMENT_CHANNELS] },
    /** 支付方式：扫码(qr) / 跳转(redirect)。缺省按渠道（微信扫码、支付宝跳转）。 */
    mode: { type: 'string', enum: ['qr', 'redirect'] },
  },
} as const;