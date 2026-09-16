import type { FastifyInstance } from 'fastify';
import { authScope, consoleSession, type GetAuthUser } from '../middleware/requireAuth.js';
import { registerConsoleErrorHandler } from '../middleware/consoleError.js';
import type { TokenService } from '../service/tokenService.js';
import type { IPersonalPlanRepo, IOrganizationPlanRepo } from '../repository/interfaces.js';
import { buildPlanCatalog } from '../service/planCatalog.js';

export interface PlansRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  personalPlanRepo: IPersonalPlanRepo;
  organizationPlanRepo: IOrganizationPlanRepo;
}

/** GET /api/plans（扩展/控制台 token，scope account，同 /api/me）：个人 + 组织套餐目录。 */
export async function plansRoutes(app: FastifyInstance, opts: PlansRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: ['extension', 'console'],
    scope: ['account'],
    routes: async (child) => {
      child.get('/api/plans', async (_req, reply) => {
        reply.send(await buildPlanCatalog(opts.personalPlanRepo, opts.organizationPlanRepo));
      });
    },
  });
}

/** GET /api/console/plans（console session，scope console）：控制台套餐目录。 */
export async function consolePlansRoutes(app: FastifyInstance, opts: PlansRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    routes: async (child) => {
      child.get('/api/console/plans', async (_req, reply) => {
        reply.send(await buildPlanCatalog(opts.personalPlanRepo, opts.organizationPlanRepo));
      });
    },
  });
}