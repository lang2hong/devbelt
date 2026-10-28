import type { FastifyInstance } from 'fastify';
import { registerConsoleErrorHandler } from '../../../middleware/consoleError.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { FeedbackService } from '../service/feedbackService.js';

/**
 * 公开反馈提交（`POST /api/db/feedback`）：无需登录。
 *
 * 匿名可达，因此必须限流：
 * - 按 IP：20 次/小时（同一出口/代理后的正常用户也够用）；
 * - 按 installId：10 次/小时（跨 IP 的刷量兜底）。
 * 正文长度与分类在 service 层校验；这里只做 schema 形态约束。
 */
export interface PublicFeedbackRouteOptions {
  service: FeedbackService;
  rateLimiter: RateLimitService;
}

const submitBody = {
  type: 'object',
  required: ['category', 'content'],
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: ['bug', 'feature', 'other'] },
    content: { type: 'string', minLength: 1, maxLength: 4000 },
    contact: { type: 'string', maxLength: 200 },
    installId: { type: 'string', maxLength: 64 },
    appVersion: { type: 'string', maxLength: 64 },
    os: { type: 'string', maxLength: 100 },
  },
} as const;

export async function publicFeedbackRoutes(app: FastifyInstance, opts: PublicFeedbackRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.post('/api/db/feedback', { schema: { body: submitBody } }, async (req, reply) => {
    const body = req.body as {
      category: 'bug' | 'feature' | 'other';
      content: string;
      contact?: string;
      installId?: string;
      appVersion?: string;
      os?: string;
    };
    await opts.rateLimiter.hit(`feedback:ip:${req.ip ?? 'unknown'}`, 3600, 20);
    if (body.installId) {
      await opts.rateLimiter.hit(`feedback:install:${body.installId}`, 3600, 10);
    }
    const r = await opts.service.submit({
      // 未登录提交：不关联账号（避免匿名反馈被冒名挂到他人名下）。
      userId: null,
      category: body.category,
      content: body.content,
      contact: body.contact,
      installId: body.installId,
      appVersion: body.appVersion,
      os: body.os,
      sourceIp: req.ip,
    });
    reply.code(201).send({ id: r.id });
  });
}