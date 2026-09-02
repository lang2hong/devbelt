import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TokenService } from '../service/tokenService.js';

/**
 * 认证用户状态查询端口：中间件只关心「用户当前还能不能用」。
 */
export type GetAuthUser = (id: number) => Promise<{ status: string } | undefined>;

export interface AuthScopeOptions {
  tokenService: TokenService;
  /** 给定了就在验签后查一次用户当前状态。 */
  getUser?: GetAuthUser;
  routes: (app: FastifyInstance) => void | Promise<void>;
}

/**
 * 认证作用域插件：内部注册的路由均需有效 access token（Ed25519 JWT）。
 *
 * access token 无 sid 会话吊销；吊销只作用于 refresh token（family 轮换 +
 * 复用检测）。所以这里只验签 + 检查用户 status（实施规格 §5.1：access token
 * 到期前可继续有效，但每个受保护请求仍检查用户状态）。
 *
 * Fastify 封装上下文语义：onRequest 钩子只作用于本插件作用域，故需认证的路由
 * 必须通过 routes 回调在此作用域内注册。
 */
export async function authScope(app: FastifyInstance, opts: AuthScopeOptions): Promise<void> {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;
    if (!token) {
      return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
    }

    let sub: string;
    try {
      const payload = await opts.tokenService.verifyAccessToken(token);
      sub = payload.sub;
    } catch {
      // 不区分过期/签名错/未知 kid，避免给攻击者反馈
      return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
    }
    const userId = Number(sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
    }

    if (opts.getUser) {
      const user = await opts.getUser(userId);
      if (!user) return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
      if (user.status !== 'active') {
        return reply.code(403).send({ message: 'user disabled', code: 'USER_DISABLED' });
      }
    }

    (req as unknown as { authUserId: number }).authUserId = userId;
  });
  await opts.routes(app);
}
