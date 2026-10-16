import type { FastifyInstance } from 'fastify';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { AiProviderService } from '../service/aiProviderService.js';

export interface AiProvidersRouteOptions {
  rateLimiter: RateLimitService;
  providers: AiProviderService;
}

const WINDOW_S = 60;
const MAX_PER_WINDOW = 60;

/**
 * `GET /api/ai/providers`：自带 Key 模式的厂商目录（仅启用项）。
 *
 * **无需登录**（自带 Key 用户可能未登录 DevBelt 账号）；只读、按 IP 限流、不含任何密钥，
 * 只暴露厂商名/baseUrl/模型 id。客户端另内置兜底预设，服务端不可达时仍可用。
 */
export async function aiProvidersRoutes(app: FastifyInstance, opts: AiProvidersRouteOptions): Promise<void> {
  app.get('/api/ai/providers', async (req, reply) => {
    await opts.rateLimiter.hit(`ai:providers:${req.ip}`, WINDOW_S, MAX_PER_WINDOW);
    const items = await opts.providers.listActive();
    reply.header('Cache-Control', 'public, max-age=300');
    reply.send({
      items: items.map((p) => ({
        code: p.code,
        name: p.name,
        baseUrl: p.baseUrl,
        models: p.models,
        sortOrder: p.sortOrder,
      })),
    });
  });
}
