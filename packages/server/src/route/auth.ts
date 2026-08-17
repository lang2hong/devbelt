import type { FastifyInstance } from 'fastify';
import type { AuthService, DeviceInfo } from '../service/authService.js';
import { authScope } from '../middleware/requireAuth.js';
import { sendError } from '../middleware/errorHandler.js';

export interface AuthRouteOptions {
  authService: AuthService;
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

  const deviceInfo = (req: any): DeviceInfo => ({
    deviceName: req.headers['x-device-name'] as string | undefined,
    deviceId: req.headers['x-device-id'] as string | undefined,
    machineId: req.headers['x-device-machine-id'] as string | undefined,
    hostname: req.headers['x-device-hostname'] as string | undefined,
    os: req.headers['x-device-os'] as string | undefined,
    arch: req.headers['x-device-arch'] as string | undefined,
    osVersion: req.headers['x-device-os-version'] as string | undefined,
    appName: req.headers['x-device-app'] as string | undefined,
    appVersion: req.headers['x-device-app-version'] as string | undefined,
    remoteName: req.headers['x-device-remote'] as string | undefined,
    language: req.headers['x-device-language'] as string | undefined,
    timezone: req.headers['x-device-timezone'] as string | undefined,
    userAgent: req.headers['user-agent'] as string | undefined,
    ip: req.ip,
  });

  app.post('/api/auth/register', async (req, reply) => {
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

  app.post('/api/auth/login', async (req, reply) => {
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

  app.post('/api/auth/refresh', async (req, reply) => {
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
    routes: async (child) => {
      child.post('/api/auth/logout', async (req, reply) => {
        const { refreshToken } = req.body as any;
        try {
          await auth.logout(refreshToken);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/api/auth/change-password', async (req, reply) => {
        const { oldPassword, newPassword } = req.body as any;
        try {
          await auth.changePassword(req.user.sub, oldPassword, newPassword);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/api/auth/sessions', async (req, reply) => {
        const userId = req.user.sub as number;
        const sessions = await auth.listSessions(userId, req.user.sid as number | undefined);
        reply.send({ sessions });
      });

      child.delete('/api/auth/sessions/:id', async (req, reply) => {
        const userId = req.user.sub as number;
        const id = Number((req.params as any).id);
        try {
          await auth.revokeSession(userId, id);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}
