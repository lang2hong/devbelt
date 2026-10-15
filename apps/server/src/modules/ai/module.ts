import type { FastifyInstance } from 'fastify';
import { aiChatRoutes, type AiChatRouteOptions } from './route/chat.js';
import { aiQuotaRoutes } from './route/quota.js';
import type { AiQuotaService } from './service/aiQuotaService.js';
import type { AiTopupService } from './service/aiTopupService.js';

export interface AiModuleOptions extends AiChatRouteOptions {
  quota: AiQuotaService;
  topup: AiTopupService;
}

/** AI 模块装配（P9 §6.8）：`POST /api/ai/chat`（SSE 代理）+ `GET /api/ai/usage`。 */
export async function aiRoutes(app: FastifyInstance, opts: AiModuleOptions): Promise<void> {
  await app.register(aiChatRoutes, opts);
  await app.register(aiQuotaRoutes, opts);
}