import type { FastifyInstance } from 'fastify';

/**
 * 用户状态查询端口。
 *
 * 中间件只需要「这个用户现在还能不能用、是什么角色」，不依赖完整的 IUserRepo，
 * 因此收窄成一个函数类型：便于测试注入，也避免中间件层反向依赖 repository。
 */
export type GetAuthUser = (id: number) => Promise<{ status: string; role: string } | undefined>;

/**
 * 会话查询端口。
 *
 * access token 的 `sid` 是签发它的那条 refresh token 的行 id，所以「会话是否
 * 还有效」这件事是可查的 —— 不需要另建 jti 黑名单。
 */
export type GetAuthSession = (
  id: number,
) => Promise<{ userId: number; revokedTime?: Date | null; expiresTime?: Date } | undefined>;

export interface AuthScopeOptions {
  routes: (app: FastifyInstance) => void | Promise<void>;
  /**
   * 给了就在 jwtVerify 之后查一次用户当前状态。
   *
   * 必须查库而不能只读 token：token 签发时用户还是 active，`status` 的当前值
   * 不可能编码在里面。不查的话「禁用账号」在实现层面等于无效 —— 现有 access
   * token 用到过期，而且可以拿 refresh 无限续期（refresh 侧的对应修复在
   * AuthService.refresh）。
   */
  getUser?: GetAuthUser;
  /**
   * 给了就校验 access token 所属会话仍然有效。
   *
   * 这是 access token 的**吊销**能力。原先没有：登出、改密、踢设备、token
   * 重用检测都只撤销 refresh token，而已经发出去的 access token 在过期前
   * （默认 15 分钟）照样能用。也就是说「立即下线」全都是延迟 15 分钟下线。
   *
   * 不需要引入 jti 黑名单：token 里的 `sid` 就是签发它的 refresh token 行 id，
   * 那一行的 `revoked_time` 已经被上述所有操作维护着，直接查即可。
   *
   * 代价是每个已认证请求多一次主键查询。与 getUser 那次查询同级，可接受 ——
   * 换来的是「撤销即刻生效」这个安全语义真正成立。
   */
  getSession?: GetAuthSession;
}

/**
 * 认证作用域插件：内部注册的路由均需有效 access token（JWT）。
 *
 * Fastify 封装上下文语义：onRequest 钩子只作用于当前插件作用域及其子作用域。
 * 因此需认证的路由必须通过 routes 回调在 authScope 作用域内注册，
 * 而非在父作用域注册后寄望钩子上浮。
 *
 * 用法：
 *   app.register(authScope, {
 *     getUser: (id) => userRepo.findById(id),
 *     routes: async (child) => {
 *       child.post('/api/auth/logout', handler);
 *     },
 *   });
 */
export async function authScope(
  app: FastifyInstance,
  opts: AuthScopeOptions,
): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      // 不区分过期/签名错/缺失，避免给攻击者反馈
      return reply.code(401).send({ message: 'unauthorized' });
    }
    if (opts.getUser) {
      const user = await opts.getUser(req.user.sub as number);
      // 用户已删除：token 仍有效但主体不存在
      if (!user) return reply.code(401).send({ message: 'unauthorized' });
      if (user.status !== 'active') {
        return reply.code(403).send({ message: 'user disabled', code: 'USER_DISABLED' });
      }
    }
    if (opts.getSession) {
      const sid = req.user.sid as number | undefined;
      // 没有 sid 的 token 是旧版签发的，无法判定会话 —— 一律拒绝。
      // 宁可让这批 token 提前失效（用户重新登录即可），也不留一条绕过吊销的路。
      if (typeof sid !== 'number') return reply.code(401).send({ message: 'unauthorized' });
      const session = await opts.getSession(sid);
      if (!session) return reply.code(401).send({ message: 'unauthorized' });
      // 会话被撤销：登出 / 改密 / 踢设备 / token 重用检测都会置这个字段
      if (session.revokedTime) {
        return reply.code(401).send({ message: 'session revoked', code: 'SESSION_REVOKED' });
      }
      // 会话自然过期。
      //
      // `expiresTime` 一直被取回来却从没被判断过 —— 于是一条「已过期但从未被
      // 撤销」的会话行仍然会为 access token 背书。当前参数下（access 15m <
      // refresh 30d）不可直接利用，但那纯属参数凑巧：任何把 access TTL 调大或
      // 把 refresh TTL 调小的改动都会让它立即成立，而且没有任何测试会发现。
      if (session.expiresTime && session.expiresTime <= new Date()) {
        return reply.code(401).send({ message: 'session expired', code: 'SESSION_EXPIRED' });
      }
      // sid 必须属于 token 里的那个用户，否则拿别人的 sid 拼一个 token 就能续命
      if (session.userId !== (req.user.sub as number)) {
        return reply.code(401).send({ message: 'unauthorized' });
      }
    }
  });
  await opts.routes(app);
}
