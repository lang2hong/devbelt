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
 * 组织授权插件（实施规格 §5 授权顺序）：
 *
 *   认证（Ed25519 验签）→ users.status=active → organization active →
 *   active membership → permission code。
 *
 * - 组织不存在 / closed / 调用者非 active membership 统一返回 `404 ORGANIZATION_NOT_FOUND`
 *   （不区分、防枚举，§5）。
 * - 权限不足返回 `403 FORBIDDEN`。
 * - 路由通过 `{ config: { permission: '...' } }` 声明所需权限码。组织 id 从 URL 的
 *   `:organizationId` 取（Workspace 选择不是授权输入，§2.5）。
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
    (req as unknown as AuthnOrgRequest).authMembershipId = membership.id;
    (req as unknown as AuthnOrgRequest).authMembershipRole = membership.role;
    (req as unknown as AuthnOrgRequest).authOrganization = org;
  });
  await opts.routes(app);
}

/**
 * organizationAuth 挂到 request 上的已解析上下文（handler 直接取用，不得重复查询）。
 * 中间件已校验组织 active + active membership，这里不重查以避免竞态（§5）。
 */
export interface AuthnOrgRequest {
  authUserId: number;
  authOrganizationId: number;
  authMembershipId: number;
  authMembershipRole: import('../domain/enums.js').OrganizationRole;
  authOrganization: import('../domain/entities.js').Organization;
}