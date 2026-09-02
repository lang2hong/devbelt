import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TokenService } from '../service/tokenService.js';
import type { GetAuthUser } from './requireAuth.js';
import type { IOrganizationRepo, IMembershipRepo } from '../repository/interfaces.js';
import type { PermissionCode } from '../authz/permissionCatalog.js';
import { roleHasPermission } from '../authz/permissionCatalog.js';

export interface OrganizationAuthOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
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
    try {
      const payload = await opts.tokenService.verifyAccessToken(token);
      userId = Number(payload.sub);
      if (!Number.isInteger(userId) || userId <= 0) throw new Error('bad sub');
    } catch {
      return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
    }

    const user = await opts.getUser(userId);
    if (!user) return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
    if (user.status !== 'active') {
      return reply.code(403).send({ message: 'user disabled', code: 'USER_DISABLED' });
    }

    const organizationId = Number((req.params as Record<string, unknown>).organizationId);
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      return reply.code(404).send({ message: 'organization not found', code: 'ORGANIZATION_NOT_FOUND' });
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

    (req as unknown as AuthnOrgRequest).authUserId = userId;
    (req as unknown as AuthnOrgRequest).authOrganizationId = organizationId;
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