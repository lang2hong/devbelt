import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 请求链路 id（P3 §11.3）：若请求已带合法 UUID 的 `X-Request-ID` 则沿用，否则生成。
 * 挂到 `req.requestId` 并在响应头回显，供排障关联；仅接受 UUID 形态，避免纳入任意
 * 客户端字符串污染日志。
 */
export async function requestId(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && UUID_RE.test(incoming) ? incoming : randomUUID();
    (req as unknown as { requestId: string }).requestId = id;
    reply.header('X-Request-ID', id);
  });
}