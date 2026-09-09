import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TokenService, AccessTokenPayload } from '../service/tokenService.js';
import type { CsrfService } from '../service/csrfService.js';
import type { GetAuthUser } from './requireAuth.js';
import type { IOrganizationRepo, IMembershipRepo } from '../repository/interfaces.js';
import type { PermissionCode } from '../authz/permissionCatalog.js';
import { roleHasPermission } from '../authz/permissionCatalog.js';
import { consoleWriteGuard } from './consoleWrite.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export interface OrganizationAuthOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  /** 核验 session（refresh family）仍存活。可由 route 缺省。 */
  getSessionActive?: (sessionId: string) => Promise<boolean>;
  /** 请求 access token 必须命中至少一个 scope。 */
  scope?: string[];
  /** console audience 的组织写请求做 Origin+会话 CSRF 校验（扩展跳过）。可选。 */
  csrfService?: CsrfService;
  consoleOrigin?: string;
  organizationRepo: IOrganizationRepo;
  membershipRepo: IMembershipRepo;
  routes: (app: FastifyInstance) => void | Promise<void>;
}

/**
 * 组织授权插件（实施规格 §2 第 5 条授权顺序）：
 *
 *   认证（Ed25519 验签）→ users.status=active → organization active →
 *   active membership → permission code。
 *
 * - 组织不存在 / closed / 调用者非 active membership 统一返回 `404 ORGANIZATION_NOT_FOUND`
 *   （不区分、防枚举，§6.1）。
 * - 权限不足返回 `403 FORBIDDEN`。
 *
 * 这里的判定发生在事务外，只是第一道闸门：写操作必须在事务内用
 * `authUserId` 重新复核操作者（§6.2），否则「放行 → 被并发降级 → 仍然提交」
 * 的竞态会绕过授权。
 * - 路由通过 `{ config: { permission: '...' } }` 声明所需权限码。组织 id 从 URL 的
 *   `:organizationId` 取（Workspace 选择不是授权输入，§2 第 5 条）。
 */
export async function organizationAuth(app: FastifyInstance, opts: OrganizationAuthOptions): Promise<void> {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
    }
    let userId: number;
    let payload: AccessTokenPayload;
    try {
      payload = (await opts.tokenService.verifyAccessToken(token)) as AccessTokenPayload;
      userId = Number(payload.sub);
      if (!Number.isInteger(userId) || userId <= 0) throw new Error('bad sub');
    } catch {
      return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
    }

    // 组织/资源是共享业务 API：同时接受 extension 与 console audience（§4.1）。
    if (payload.aud !== 'extension' && payload.aud !== 'console') {
      return reply.code(403).send({ message: 'token audience not allowed here', code: 'TOKEN_AUDIENCE_FORBIDDEN' });
    }
    // per-route audience 收窄：资源 detail/写与目录写仅 extension（浏览器不得接组织业务内容）。
    const routeAud = (req.routeOptions as { config?: { aud?: string } }).config?.aud;
    if (routeAud && payload.aud !== routeAud) {
      return reply.code(403).send({ message: 'token audience not allowed here', code: 'TOKEN_AUDIENCE_FORBIDDEN' });
    }
    if (opts.scope && opts.scope.length > 0) {
      const scopes = new Set(payload.scope ?? []);
      if (!opts.scope.some((s) => scopes.has(s))) {
        return reply.code(403).send({ message: 'forbidden', code: 'FORBIDDEN' });
      }
    }

    const user = await opts.getUser(userId);
    if (!user) return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
    if (user.status !== 'active') {
      return reply.code(403).send({ message: 'user disabled', code: 'USER_DISABLED' });
    }
    if (payload.sessionVersion !== undefined && payload.sessionVersion !== user.sessionVersion) {
      return reply.code(401).send({ message: 'session expired', code: 'UNAUTHORIZED' });
    }
    if (opts.getSessionActive && typeof payload.sessionId === 'string') {
      const active = await opts.getSessionActive(payload.sessionId).catch(() => false);
      if (!active) {
        return reply.code(401).send({ message: 'session expired', code: 'UNAUTHORIZED' });
      }
    }

    // 挂会话上下文（供 consoleWriteGuard 读取 audience/sessionId）。
    (req as unknown as { authAudience?: string }).authAudience = payload.aud;
    (req as unknown as { authSessionId?: string }).authSessionId = payload.sessionId;
    (req as unknown as { authDeviceId?: number }).authDeviceId = payload.deviceId;

    // console audience 的组织写请求（POST/PATCH/PUT/DELETE）须 Origin 同源 + 会话绑定 CSRF。
    if (opts.csrfService && opts.consoleOrigin && payload.aud === 'console' && WRITE_METHODS.has(req.method)) {
      if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
        return reply.code(403).send({ message: 'forbidden', code: 'FORBIDDEN' });
      }
    }

    const organizationId = Number((req.params as Record<string, unknown>).organizationId);
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      return reply.code(404).send({ message: 'organization not found', code: 'ORGANIZATION_NOT_FOUND' });
    }

    (req as unknown as AuthnOrgRequest).authUserId = userId;
    (req as unknown as AuthnOrgRequest).authOrganizationId = organizationId;

    // 组织管理写且带 Idempotency-Key 时，跳过此处的实时组织/成员/权限快速失败检查：
    // 已完成的同 key 回执必须在「组织已关闭 / 成员已退出或已被移除」之后仍能重放（§6.1）。
    // 首次写入、摘要不符、或非管理写（资源/目录，aud:'extension'）不做跳过，仍按原序快速失败；
    // service 事务内仍以 lockActiveOrganization / requireActor / requireMembershipInTx 复核授权，
    // 因此跳过本预览不致削弱最终授权边界。
    const keyedManageWrite = WRITE_METHODS.has(req.method) && req.headers['idempotency-key'] !== undefined && routeAud === undefined;
    if (keyedManageWrite) {
      return;
    }

    const org = await opts.organizationRepo.findById(organizationId);
    if (!org || org.status !== 'active') {
      return reply.code(404).send({ message: 'organization not found', code: 'ORGANIZATION_NOT_FOUND' });
    }

    const membership = await opts.membershipRepo.findByOrgAndUser(organizationId, userId);
    if (!membership || membership.status !== 'active') {
      return reply.code(404).send({ message: 'organization not found', code: 'ORGANIZATION_NOT_FOUND' });
    }

    const permission = (req.routeOptions as { config?: { permission?: PermissionCode } }).config?.permission;
    if (permission && !roleHasPermission(membership.role, permission)) {
      return reply.code(403).send({ message: 'forbidden', code: 'FORBIDDEN' });
    }

    (req as unknown as AuthnOrgRequest).authMembershipRole = membership.role;
    (req as unknown as AuthnOrgRequest).authOrganization = org;
  });
  await opts.routes(app);
}

/**
 * organizationAuth 挂到 request 上的已解析上下文。
 *
 * 这些值只反映**请求进入时**的状态，仅可用于只读响应组装。写路径不得据此授权或
 * 记账：本钩子在事务外执行，放行后操作者可能被并发降级/移除。因此写操作只传
 * `authUserId`，由 service 在组织锁内重锁 membership、重算权限码并取用锁内
 * membership id（§6.1/§6.2）。
 *
 * 也因此不再暴露 `authMembershipId` —— 它曾被资源写入直接当作作者字段，
 * 会把写入归属到已失效的 membership。
 */
export interface AuthnOrgRequest {
  authUserId: number;
  authOrganizationId: number;
  authMembershipRole: import('../domain/enums.js').OrganizationRole;
  authOrganization: import('../domain/entities.js').Organization;
}