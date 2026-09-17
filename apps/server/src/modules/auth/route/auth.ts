import type { FastifyInstance } from 'fastify';
import type { AuthService, DeviceFields } from '../service/authService.js';
import { authScope, type GetAuthUser } from '../../../middleware/requireAuth.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import type { CsrfService } from '../../../service/csrfService.js';
import { DomainError } from '../../../domain/errors.js';
import { sendError } from '../../../middleware/errorHandler.js';
import { consoleWriteGuard, clearSessionCookies } from '../../../middleware/consoleWrite.js';
import { changePasswordBody, loginBody, refreshBody, registerBody, resendBody, verificationTokenParam } from '../../../route/schemas.js';

export interface AuthRouteOptions {
  authService: AuthService;
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  auditWriter: AuditWriter;
  csrfService: CsrfService;
  consoleOrigin: string;
}

/**
 * 认证路由（HTTP 层）：仅编组 AuthService + 序列化，无业务逻辑。
 * 公开：register / login / refresh / logout / confirm-email / resend-verification
 * 需认证：change-password（包在 authScope 子作用域）
 *
 * 设备字段从请求体读取。
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
      opts.auditWriter.write({ eventType: 'auth.login.success', result: 'success', actorUserId: Number(r.user.userId), sourceIp: req.ip });
      reply.send(r);
    } catch (e) {
      opts.auditWriter.write({ eventType: 'auth.login.failed', result: 'failure', failureCode: e instanceof DomainError ? e.code : null, sourceIp: req.ip });
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

  // 登出凭 refresh token，匿名即可：撤销需要 token 本身。
  app.post('/api/auth/logout', { schema: { body: { type: 'object', additionalProperties: false, properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } } } } }, async (req, reply) => {
    const refreshToken = (req.body as any)?.refreshToken as string | undefined;
    try {
      const r = await auth.logout(refreshToken);
      opts.auditWriter.write({ eventType: 'auth.logout', result: 'success', sourceIp: req.ip });
      reply.send(r);
    } catch (e) {
      sendError(reply, e);
    }
  });

  // 以下需认证
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: ['extension', 'console'],
    scope: ['account'],
    routes: async (child) => {
      child.post('/api/auth/change-password', { schema: { body: changePasswordBody } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
          return reply.code(403).send({ message: 'forbidden', code: 'FORBIDDEN' });
        }
        const { currentPassword, newPassword } = req.body as any;
        const userId = (req as any).authUserId as number;
        try {
          const r = await auth.changePassword(userId, currentPassword, newPassword);
          opts.auditWriter.write({
            eventType: 'auth.password.changed',
            result: 'success',
            actorUserId: userId,
            sourceIp: req.ip,
            requestId: (req as unknown as { requestId?: string }).requestId ?? 'unknown',
          });
          // 改密使所有会话失效：服务端清除 refresh/csrf cookie（§4.2 L131），响应携带重登码。
          clearSessionCookies(reply);
          reply.send({ ...r, code: 'PASSWORD_CHANGED_RELOGIN_REQUIRED' });
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}
