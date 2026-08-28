import type { FastifyInstance } from 'fastify';
import type { AuthService, DeviceFields } from '../service/authService.js';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import type { TokenService } from '../service/tokenService.js';
import { sendError } from '../middleware/errorHandler.js';
import { changePasswordBody, loginBody, refreshBody, registerBody, resendBody, verificationTokenParam } from './schemas.js';

export interface AuthRouteOptions {
  authService: AuthService;
  tokenService: TokenService;
  getUser: GetAuthUser;
}

/**
 * 认证路由（HTTP 层）：仅编组 AuthService + 序列化，无业务逻辑。
 * 公开：register / login / refresh / logout / confirm-email / resend-verification
 * 需认证：change-password（包在 authScope 子作用域）
 *
 * 设备字段从请求体读取（V3 DeviceFields，非 V2 的请求头）。
 */
export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions): Promise<void> {
  const auth = opts.authService;

  app.post('/api/auth/register', { schema: { body: registerBody } }, async (req, reply) => {
    const { email, password, displayName } = req.body as any;
    try {
      const r = await auth.register(email, password, displayName, req.ip);
      reply.code(201).send(r);
    } catch (e) {
      sendError(reply, e);
    }
  });

  app.post(
    '/api/auth/email-verifications/:token/confirm',
    { schema: { params: verificationTokenParam } },
    async (req, reply) => {
      const token = (req.params as any).token;
      try {
        const r = await auth.confirmEmail(token);
        reply.send(r);
      } catch (e) {
        sendError(reply, e);
      }
    },
  );

  // 匿名重发验证 token（body 含 email），不区分邮箱是否存在/已验证（防枚举）
  app.post('/api/auth/email-verifications', { schema: { body: resendBody } }, async (req, reply) => {
    const { email } = req.body as any;
    try {
      const r = await auth.resendVerification(email, req.ip);
      reply.send(r);
    } catch (e) {
      sendError(reply, e);
    }
  });

  app.post('/api/auth/login', { schema: { body: loginBody } }, async (req, reply) => {
    const { email, password, deviceKey, devicePlatform, deviceName, clientVersion } = req.body as any;
    const device: DeviceFields = { deviceKey, devicePlatform, deviceName, clientVersion };
    try {
      const r = await auth.login(email, password, device, req.ip);
      reply.send(r);
    } catch (e) {
      sendError(reply, e);
    }
  });

  app.post('/api/auth/refresh', { schema: { body: refreshBody } }, async (req, reply) => {
    const { refreshToken, deviceKey, devicePlatform, deviceName, clientVersion } = req.body as any;
    const device: DeviceFields = { deviceKey, devicePlatform, deviceName, clientVersion };
    try {
      const r = await auth.refresh(refreshToken, device);
      reply.send(r);
    } catch (e) {
      sendError(reply, e);
    }
  });

  // 登出凭 refresh token（V3 access token 无 sid），匿名即可：撤销需要 token 本身。
  app.post('/api/auth/logout', { schema: { body: { type: 'object', additionalProperties: false, properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } } } } }, async (req, reply) => {
    const refreshToken = (req.body as any)?.refreshToken as string | undefined;
    try {
      const r = await auth.logout(refreshToken);
      reply.send(r);
    } catch (e) {
      sendError(reply, e);
    }
  });

  // 以下需认证
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    routes: async (child) => {
      child.post('/api/auth/change-password', { schema: { body: changePasswordBody } }, async (req, reply) => {
        const { currentPassword, newPassword } = req.body as any;
        const userId = (req as any).authUserId as number;
        try {
          const r = await auth.changePassword(userId, currentPassword, newPassword);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}