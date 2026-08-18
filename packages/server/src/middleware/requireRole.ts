import type { FastifyInstance } from 'fastify';
import type { Role } from '../domain/enums.js';
import type { GetAuthUser, GetAuthSession } from './requireAuth.js';

export interface RequireRoleOptions {
  routes: (app: FastifyInstance) => void | Promise<void>;
  /**
   * 给了就以 DB 里的 role 为准，而非 token 声明。
   *
   * token 里的 `role` 是签发时的快照：admin 被 `PATCH /admin/users/:id` 降级后，
   * 其现有 access token 在有效期内（默认 15 分钟）仍带 `role: 'admin'`，
   * 只读 token 等于降级要等一刻钟才生效。同时顺带校验 status。
   */
  getUser?: GetAuthUser;
  /**
   * 给了就校验 access token 所属会话未被撤销（见 authScope.getSession）。
   *
   * admin 路由尤其需要：管理员被踢下线后，其 access token 若还能调
   * `/admin/*`，撤销就只是名义上的。
   */
  getSession?: GetAuthSession;
}

/**
 * RBAC 角色校验作用域（高阶插件）：需认证 + 角色匹配。
 * 与 authScope 区别：authScope 仅认证；requireRole 额外校验角色。
 *
 * 用法：
 *   app.register(requireRole(['admin']), {
 *     getUser: (id) => userRepo.findById(id),
 *     routes: async (c) => {...},
 *   });
 */
export function requireRole(roles: Role[]) {
  return async (app: FastifyInstance, opts: RequireRoleOptions): Promise<void> => {
    app.addHook('onRequest', async (req, reply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ message: 'unauthorized' });
      }

      // 有 getUser 时一律以 DB 为准；否则退回 token 声明（兼容未注入的调用方）
      let role = req.user?.role as Role | undefined;
      if (opts.getUser) {
        const user = await opts.getUser(req.user.sub as number);
        if (!user) return reply.code(401).send({ message: 'unauthorized' });
        if (user.status !== 'active') {
          return reply.code(403).send({ message: 'user disabled', code: 'USER_DISABLED' });
        }
        role = user.role as Role;
      }

      if (opts.getSession) {
        const sid = req.user?.sid as number | undefined;
        if (typeof sid !== 'number') return reply.code(401).send({ message: 'unauthorized' });
        const session = await opts.getSession(sid);
        if (!session) return reply.code(401).send({ message: 'unauthorized' });
        if (session.revokedTime) {
          return reply.code(401).send({ message: 'session revoked', code: 'SESSION_REVOKED' });
        }
        // 自然过期与撤销同级处理，理由见 requireAuth 中的同名判定
        if (session.expiresTime && session.expiresTime <= new Date()) {
          return reply.code(401).send({ message: 'session expired', code: 'SESSION_EXPIRED' });
        }
        if (session.userId !== (req.user.sub as number)) {
          return reply.code(401).send({ message: 'unauthorized' });
        }
      }

      if (!role || !roles.includes(role)) {
        return reply.code(403).send({ message: 'forbidden' });
      }
    });
    await opts.routes(app);
  };
}
