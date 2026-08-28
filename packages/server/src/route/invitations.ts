import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import type { TokenService } from '../service/tokenService.js';
import type { OrganizationService, OrganizationDto } from '../service/organizationService.js';
import { sendError } from '../middleware/errorHandler.js';
import { invitationTokenParam } from './schemas.js';

export interface InvitationRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  organizationService: OrganizationService;
}

/**
 * 邀请接受路由（§5）：`POST /api/organization-invitations/:token/accept`。
 *
 * 只需认证（authScope），组织作用域由邀请 token 反查 —— 这个路由的 URL 里没有
 * `:organizationId`，授权不能走 organizationAuth。
 */
export async function invitationRoutes(app: FastifyInstance, opts: InvitationRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    routes: async (auth) => {
      auth.post('/api/organization-invitations/:token/accept', { schema: { params: invitationTokenParam } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const token = (req.params as any).token as string;
        try {
          const r = await opts.organizationService.acceptInvitation(token, userId);
          reply.send({ organization: orgDto(r.organization) });
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}

function orgDto(o: OrganizationDto) {
  return {
    organizationId: String(o.organizationId),
    name: o.name,
    status: o.status,
    closedTime: o.closedTime ? o.closedTime.toISOString() : null,
    role: o.role,
  };
}