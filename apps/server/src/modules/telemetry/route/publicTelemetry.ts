import type { FastifyInstance } from 'fastify';
import { registerConsoleErrorHandler } from '../../../middleware/consoleError.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { TelemetryService } from '../service/telemetryService.js';

/**
 * 公开安装心跳（`POST /api/db/telemetry/heartbeat`）：无需登录。
 *
 * 匿名可达，因此必须限流：
 * - 按 IP：60 次/小时（共享出口/代理后的正常用户也够用）；
 * - 按 installId：5 次/天（正常扩展每天最多一次，留出窗口重试余量）。
 *
 * 不接收/不存储 IP、账号、邮箱或连接信息；IP 只用于限流键。
 */
export interface PublicTelemetryRouteOptions {
  service: TelemetryService;
  rateLimiter: RateLimitService;
}

const UUID_V4_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

const heartbeatBody = {
  type: 'object',
  required: ['installId', 'appVersion'],
  additionalProperties: false,
  properties: {
    installId: { type: 'string', pattern: UUID_V4_PATTERN, maxLength: 36 },
    appVersion: { type: 'string', minLength: 1, maxLength: 64 },
    os: { type: 'string', maxLength: 32 },
    arch: { type: 'string', maxLength: 32 },
    isRemote: { type: 'boolean' },
  },
} as const;

export async function publicTelemetryRoutes(
  app: FastifyInstance,
  opts: PublicTelemetryRouteOptions,
): Promise<void> {
  registerConsoleErrorHandler(app);

  app.post('/api/db/telemetry/heartbeat', { schema: { body: heartbeatBody } }, async (req, reply) => {
    const body = req.body as {
      installId: string;
      appVersion: string;
      os?: string;
      arch?: string;
      isRemote?: boolean;
    };
    await opts.rateLimiter.hit(`telemetry:ip:${req.ip ?? 'unknown'}`, 3600, 60);
    await opts.rateLimiter.hit(`telemetry:install:${body.installId.toLowerCase()}`, 86_400, 5);
    await opts.service.heartbeat(body);
    reply.code(204).send();
  });
}