import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authScope, type GetAuthUser } from '../../../middleware/requireAuth.js';
import { sendError } from '../../../middleware/errorHandler.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import { AiQuotaExceededError } from '../domain/errors.js';
import type { AiProxyService, ValidatedChatRequest } from '../service/aiProxyService.js';
import type { AiReservation } from '../service/aiQuotaService.js';

export interface AiChatRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  rateLimiter: RateLimitService;
  proxy: AiProxyService;
  /** 每分钟请求数（默认 20，对齐其他 POST 接口）。 */
  rateLimitPerMinute?: number;
}

const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;

/**
 * `POST /api/ai/chat`（P9 §6.8）：登录态（扩展 Bearer / console token）→ 固定窗限流
 * → 校验 → 额度预占（409）→ hijack 后 parse-and-forward SSE。
 */
export async function aiChatRoutes(app: FastifyInstance, opts: AiChatRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: ['extension', 'console'],
    scope: ['account'],
    routes: async (child) => {
      child.post('/api/ai/chat', async (req, reply) => {
        const userId = (req as unknown as { authUserId: number }).authUserId;

        const started = await (async (): Promise<{ body: ValidatedChatRequest; reservation: AiReservation } | null> => {
          try {
            await opts.rateLimiter.hit(
              `ai:chat:user:${userId}`,
              60,
              opts.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
            );
            const body = opts.proxy.validate(req.body);
            const reservation = await opts.proxy.begin(userId, body);
            return { body, reservation };
          } catch (e) {
            if (e instanceof AiQuotaExceededError) {
              reply.code(409).send({
                message: e.message,
                code: e.code,
                limit: e.quota.limit,
                used: e.quota.used,
                reserved: e.quota.reserved,
                resetAt: e.quota.resetAt,
              });
              return null;
            }
            sendError(reply, e);
            return null;
          }
        })();
        if (!started) return;

        // 进入 SSE：接管原始响应；此后由代理负责写错误（预流 JSON / 流中 SSE error 事件）。
        reply.hijack();
        await opts.proxy.forward({
          userId,
          body: started.body,
          reservation: started.reservation,
          res: reply.raw,
          requestId: requestIdOf(req),
        });
      });
    },
  });
}

function requestIdOf(req: FastifyRequest): string | undefined {
  const id = (req as unknown as { requestId?: string }).requestId;
  return typeof id === 'string' ? id : undefined;
}