import type { FastifyInstance } from 'fastify';
import type { AuthService, DeviceInfo } from '../service/authService.js';
import { authScope, type GetAuthUser, type GetAuthSession } from '../middleware/requireAuth.js';
import { sendError } from '../middleware/errorHandler.js';
import {
  changePasswordBody,
  credentialsBody,
  logoutBody,
  refreshTokenBody,
} from './schemas.js';
import { readDeviceHeaders, readDeviceId } from './deviceHeaders.js';

export interface AuthRouteOptions {
  authService: AuthService;
  getUser?: GetAuthUser;
  getSession?: GetAuthSession;
}

/**
 * 认证路由（HTTP 层）：仅编组 AuthService + 序列化，无业务逻辑。
 * 公开：register / login / refresh
 * 需认证：logout / change-password / sessions / sessions/:id（包在 authScope 子作用域）
 *
 * 兼容旧客户端：register/login/refresh 响应附带 token/userId/role 顶层字段，
 * 旧 syncClient 读 token；新客户端读 accessToken/refreshToken。
 */
export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions): Promise<void> {
  const auth = opts.authService;

  /**
   * 从请求头读设备信息。
   *
   * 逐字段截断到 DB 列宽，见 deviceHeaders.ts —— 原来是原样透传，一个 300 字符的
   * User-Agent（真实存在）就会让 `refresh_tokens` / `devices` 的 INSERT 撞
   * `ER_DATA_TOO_LONG`，登录直接 500 且那类客户端永远登不上。
   */
  const deviceInfo = (req: any): DeviceInfo => readDeviceHeaders(req);

  app.post('/api/auth/register', { schema: { body: credentialsBody } }, async (req, reply) => {
    const { email, password } = req.body as any;
    try {
      const r = await auth.register(email, password, deviceInfo(req));
      reply.code(201).send({
        ...r,
        token: r.accessToken,
        userId: r.user.id,
        role: r.user.role,
      });
    } catch (e) {
      sendError(reply, e);
    }
  });

  app.post('/api/auth/login', { schema: { body: credentialsBody } }, async (req, reply) => {
    const { email, password } = req.body as any;
    try {
      const r = await auth.login(email, password, deviceInfo(req));
      reply.send({
        ...r,
        token: r.accessToken,
        userId: r.user.id,
        role: r.user.role,
      });
    } catch (e) {
      sendError(reply, e);
    }
  });

  app.post('/api/auth/refresh', { schema: { body: refreshTokenBody } }, async (req, reply) => {
    const { refreshToken } = req.body as any;
    try {
      const r = await auth.refresh(refreshToken, deviceInfo(req));
      reply.send({ ...r, token: r.accessToken });
    } catch (e) {
      sendError(reply, e);
    }
  });

  // 以下路由需认证（authScope 子作用域）
  app.register(authScope, {
    getUser: opts.getUser,
    getSession: opts.getSession,
    routes: async (child) => {
      child.post('/api/auth/logout', { schema: { body: logoutBody } }, async (req, reply) => {
        // body 可以整体缺失（fetch 不带 body），故不能直接解构
        const refreshToken = (req.body as any)?.refreshToken as string | undefined;
        try {
          // sid 是权威判据：即使客户端手上的 refresh token 已被攻击者轮换掉，
          // 当前会话也必须被撤销。见 AuthService.logout 的说明。
          await auth.logout(req.user.sid as number, req.user.sub as number, refreshToken);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/api/auth/change-password', { schema: { body: changePasswordBody } }, async (req, reply) => {
        const { oldPassword, newPassword } = req.body as any;
        try {
          await auth.changePassword(req.user.sub, oldPassword, newPassword);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/api/devices', async (req, reply) => {
        const userId = req.user.sub as number;
        try {
          const devices = await auth.listDevices(userId);
          reply.send({ devices, currentDeviceId: readDeviceId(req) });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.delete('/api/devices/:deviceId', async (req, reply) => {
        const userId = req.user.sub as number;
        const deviceId = String((req.params as any).deviceId);
        try {
          await auth.revokeDevice(userId, deviceId);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}
