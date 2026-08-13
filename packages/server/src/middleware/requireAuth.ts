import type { FastifyInstance } from 'fastify';

/**
 * 认证作用域插件：内部注册的路由均需有效 access token（JWT）。
 *
 * Fastify 封装上下文语义：onRequest 钩子只作用于当前插件作用域及其子作用域。
 * 因此需认证的路由必须通过 routes 回调在 authScope 作用域内注册，
 * 而非在父作用域注册后寄望钩子上浮。
 *
 * 用法：
 *   app.register(authScope, {
 *     routes: async (child) => {
 *       child.post('/api/auth/logout', handler);
 *     },
 *   });
 */
export async function authScope(
  app: FastifyInstance,
  opts: { routes: (app: FastifyInstance) => void | Promise<void> },
): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ message: 'unauthorized' });
    }
  });
  await opts.routes(app);
}
