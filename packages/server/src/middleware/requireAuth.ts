import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TokenService, AccessTokenPayload } from '../service/tokenService.js';
import type { TokenAudience, UserRole } from '../domain/enums.js';

/**
 * 认证用户状态查询端口：中间件只关心「用户当前还能不能用」 + 会话版本（+ 平台角色）。
 */
export type AuthUser = { status: string; sessionVersion: number; role: UserRole };
export type GetAuthUser = (id: number) => Promise<AuthUser | undefined>;

export interface AuthScopeOptions {
  tokenService: TokenService;
  /** 允许的 audience（单值或集合）。缺省 extension。 */
  aud?: TokenAudience | TokenAudience[];
  /** 请求 access token 必须命中至少一个 scope。 */
  scope?: string[];
  /** 给定了就在验签后查一次用户当前状态 + 会话版本。 */
  getUser?: GetAuthUser;
  /** 给定了就核验 session（refresh family）仍存活（撤销设备/登出/复用检测后立即失效）。 */
  getSessionActive?: (sessionId: string) => Promise<boolean>;
  /** 仅对 consoleSession 生效：要求调用者是 platform_admin（§6 平台运营）。 */
  requireAdmin?: boolean;
  routes: (app: FastifyInstance) => void | Promise<void>;
}

type EvalResult =
  | { kind: 'ok'; userId: number; sessionId?: string; deviceId?: number; audience: TokenAudience; role: UserRole }
  | { kind: 'error'; status: number; code: string; message: string };

async function evaluate(
  tokenService: TokenService,
  opts: AuthScopeOptions,
  req: FastifyRequest,
): Promise<EvalResult> {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : undefined;
  if (!token) return { kind: 'error', status: 401, code: 'UNAUTHORIZED', message: 'unauthorized' };

  let payload: AccessTokenPayload;
  try {
    payload = await tokenService.verifyAccessToken(token);
  } catch {
    return { kind: 'error', status: 401, code: 'UNAUTHORIZED', message: 'unauthorized' };
  }

  const allowedAud = opts.aud === undefined ? ['extension'] : Array.isArray(opts.aud) ? opts.aud : [opts.aud];
  if (!allowedAud.includes(payload.aud)) {
    return { kind: 'error', status: 403, code: 'TOKEN_AUDIENCE_FORBIDDEN', message: 'token audience not allowed here' };
  }

  if (opts.scope && opts.scope.length > 0) {
    const scopes = new Set(payload.scope ?? []);
    if (!opts.scope.some((s) => scopes.has(s))) {
      return { kind: 'error', status: 403, code: 'FORBIDDEN', message: 'forbidden' };
    }
  }

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    return { kind: 'error', status: 401, code: 'UNAUTHORIZED', message: 'unauthorized' };
  }

  let role: UserRole = 'user';
  if (opts.getUser) {
    const user = await opts.getUser(userId);
    if (!user) return { kind: 'error', status: 401, code: 'UNAUTHORIZED', message: 'unauthorized' };
    if (user.status !== 'active') {
      return { kind: 'error', status: 403, code: 'USER_DISABLED', message: 'user disabled' };
    }
    // sessionVersion 快照不匹配 = 改密/禁用导致会话失效（§4.1）。不区分原因，回 401 走 refresh/重登。
    if (payload.sessionVersion !== undefined && payload.sessionVersion !== user.sessionVersion) {
      return { kind: 'error', status: 401, code: 'UNAUTHORIZED', message: 'session expired' };
    }
    role = user.role;
  }

  if (opts.getSessionActive && typeof payload.sessionId === 'string') {
    const active = await opts.getSessionActive(payload.sessionId).catch(() => false);
    if (!active) {
      return { kind: 'error', status: 401, code: 'UNAUTHORIZED', message: 'session expired' };
    }
  }

  return { kind: 'ok', userId, sessionId: payload.sessionId, deviceId: payload.deviceId, audience: payload.aud, role };
}

/**
 * 认证作用域插件（扩展 + 共享业务 API）：内部注册的路由均需有效 access token。
 *
 * 在既有验签 + users.status 基础上增加：aud/scope 校验、sessionVersion 校验、
 * session（refresh family）存活校验。响应沿用扩展侧 `{ message, code }` 平铺信封。
 */
export async function authScope(app: FastifyInstance, opts: AuthScopeOptions): Promise<void> {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await evaluate(opts.tokenService, opts, req);
    if (result.kind === 'error') {
      return reply.code(result.status).send({ message: result.message, code: result.code });
    }
    setAuthContext(req, result);
  });
  await opts.routes(app);
}

export function setAuthContext(req: FastifyRequest, result: Extract<EvalResult, { kind: 'ok' }>): void {
  (req as unknown as { authUserId: number }).authUserId = result.userId;
  (req as unknown as { authSessionId?: string }).authSessionId = result.sessionId;
  (req as unknown as { authDeviceId?: number }).authDeviceId = result.deviceId;
  (req as unknown as { authAudience?: TokenAudience }).authAudience = result.audience;
  (req as unknown as { authActorRole?: UserRole }).authActorRole = result.role;
}

/**
 * 控制台认证作用域插件（`/api/console/*`）：与 authScope 相同的会话核验，但错误走
 * §6 控制台信封 `{ error: { code, message } }`；aud 缺省 console。
 * 统一在此处校验 Accept: application/json（缺失/非 JSON → 406），避免每个控制台路由重复实现。
 */
export async function consoleSession(app: FastifyInstance, opts: AuthScopeOptions): Promise<void> {
  const effectiveOpts: AuthScopeOptions = { ...opts, aud: opts.aud ?? 'console' };
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await evaluate(effectiveOpts.tokenService, effectiveOpts, req);
    if (result.kind === 'error') {
      return reply.code(result.status).send({ error: { code: result.code, message: result.message } });
    }
    if (effectiveOpts.requireAdmin && result.role !== 'platform_admin') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'platform admin required' } });
    }
    if (!acceptsJson(req)) {
      return reply.code(406).send({ error: { code: 'NOT_ACCEPTABLE', message: 'Accept must include application/json' } });
    }
    setAuthContext(req, result);
  });
  await opts.routes(app);
}

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

function acceptsJson(req: FastifyRequest): boolean {
  const a = (headerOf(req, 'accept') ?? '').toLowerCase();
  return a.includes('application/json') || a.includes('*/*');
}
