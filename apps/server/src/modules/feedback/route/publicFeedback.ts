import type { FastifyInstance } from 'fastify';
import { registerConsoleErrorHandler } from '../../../middleware/consoleError.js';
import { resolveOptionalAuthUserId, type GetAuthUser } from '../../../middleware/requireAuth.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { FeedbackService } from '../service/feedbackService.js';

/**
 * 公开反馈端点（无需登录；带有效扩展 token 时关联账号）。
 *
 * - `POST /api/db/feedback`：提交。按 IP 20 次/小时 + 按 installId 10 次/小时。
 * - `POST /api/db/feedback/thread`：读取自己的反馈与管理员回复（插件拉取，非实时）。
 *   凭证放 body（不进 URL / 访问日志）。按 IP 60 次/小时 + 按 installId 30 次/小时；
 *   凭证不匹配一律返回空列表，不区分「不存在」与「凭证错误」。
 *
 * 可选登录：token 无效/过期时按匿名处理，**不返回 401**，避免阻断反馈提交。
 */
export interface PublicFeedbackRouteOptions {
  service: FeedbackService;
  rateLimiter: RateLimitService;
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive?: (sessionId: string) => Promise<boolean>;
}

const REPLY_KEY_SCHEMA = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } as const;

const submitBody = {
  type: 'object',
  required: ['category', 'content'],
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: ['bug', 'feature', 'other'] },
    content: { type: 'string', minLength: 1, maxLength: 4000 },
    contact: { type: 'string', maxLength: 200 },
    installId: { type: 'string', maxLength: 64 },
    replyKey: REPLY_KEY_SCHEMA,
    appVersion: { type: 'string', maxLength: 64 },
    os: { type: 'string', maxLength: 100 },
    // 图片：最多 3 张、每张 base64 后 ≤ ~2.8 MB（原图 2 MiB）。mime 由服务端按魔数判定。
    images: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        required: ['dataBase64'],
        additionalProperties: false,
        properties: {
          fileName: { type: 'string', maxLength: 200 },
          dataBase64: { type: 'string', minLength: 4, maxLength: 2_800_000 },
        },
      },
    },
  },
} as const;

const threadBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    installId: { type: 'string', maxLength: 64 },
    replyKey: REPLY_KEY_SCHEMA,
  },
} as const;

export async function publicFeedbackRoutes(app: FastifyInstance, opts: PublicFeedbackRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  const authUserId = (req: Parameters<typeof resolveOptionalAuthUserId>[0]) =>
    resolveOptionalAuthUserId(req, {
      tokenService: opts.tokenService,
      getUser: opts.getUser,
      getSessionActive: opts.getSessionActive,
    });

  app.post('/api/db/feedback', { schema: { body: submitBody }, bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body as {
      category: 'bug' | 'feature' | 'other';
      content: string;
      contact?: string;
      installId?: string;
      replyKey?: string;
      appVersion?: string;
      os?: string;
      images?: Array<{ fileName?: string; dataBase64: string }>;
    };
    await opts.rateLimiter.hit(`feedback:ip:${req.ip ?? 'unknown'}`, 3600, 20);
    if (body.installId) {
      await opts.rateLimiter.hit(`feedback:install:${body.installId}`, 3600, 10);
    }
    const r = await opts.service.submit({
      // 只认服务端验证过的 token；body 里不接受 userId，避免冒名挂靠。
      userId: await authUserId(req),
      category: body.category,
      content: body.content,
      contact: body.contact,
      installId: body.installId,
      replyKey: body.replyKey,
      appVersion: body.appVersion,
      os: body.os,
      sourceIp: req.ip,
      images: body.images,
    });
    reply.code(201).send({ id: r.id });
  });

  app.post('/api/db/feedback/thread', { schema: { body: threadBody } }, async (req, reply) => {
    const body = (req.body ?? {}) as { installId?: string; replyKey?: string };
    await opts.rateLimiter.hit(`feedback:thread:ip:${req.ip ?? 'unknown'}`, 3600, 60);
    if (body.installId) {
      await opts.rateLimiter.hit(`feedback:thread:install:${body.installId}`, 3600, 30);
    }
    const items = await opts.service.thread({
      installId: body.installId,
      replyKey: body.replyKey,
      userId: await authUserId(req),
    });
    reply.header('Cache-Control', 'no-store').send({
      items: items.map((i) => ({
        id: String(i.id),
        category: i.category,
        content: i.content,
        status: i.status,
        createTime: i.createTime.toISOString(),
        replies: i.replies.map((r) => ({ id: String(r.id), body: r.body, createTime: r.createTime.toISOString() })),
      })),
    });
  });
}
