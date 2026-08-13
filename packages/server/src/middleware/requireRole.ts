import type { FastifyInstance } from 'fastify';
import type { Role } from '../domain/enums.js';

/**
 * RBAC 角色校验作用域（高阶插件）：需认证 + 角色匹配。
 * 与 authScope 区别：authScope 仅认证；requireRole 额外校验角色。
 *
 * 用法：app.register(requireRole(['admin']), { routes: async (c) => {...} });
 */
export function requireRole(roles: Role[]) {
  return async (app: FastifyInstance, opts: { routes: (app: FastifyInstance) => void | Promise<void> }): Promise<void> => {
    app.addHook('onRequest', async (req, reply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ message: 'unauthorized' });
      }
      if (!roles.includes(req.user?.role as Role)) {
        return reply.code(403).send({ message: 'forbidden' });
      }
    });
    await opts.routes(app);
  };
}
