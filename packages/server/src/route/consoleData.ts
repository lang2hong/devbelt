import type { FastifyInstance, FastifyRequest } from 'fastify';
import { consoleSession } from '../middleware/requireAuth.js';
import { registerConsoleErrorHandler, rejectConsole } from '../middleware/consoleError.js';
import type { TokenService } from '../service/tokenService.js';
import type { AuditWriter } from '../service/auditWriter.js';
import type { RateLimitService } from '../service/rateLimitService.js';
import type { GetAuthUser } from '../middleware/requireAuth.js';
import type {
  IUserRepo,
  IPersonalSubscriptionRepo,
  IPlanRepo,
  IMembershipRepo,
  ISyncStateRepo,
  ISyncRecordRepo,
  IOrganizationRepo,
} from '../repository/interfaces.js';
import type { Queryable } from '../repository/mysql/db.js';
import { deriveEntitlement } from '../service/entitlement.js';
import { organizationIdParam } from './schemas.js';

export interface ConsoleDataRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  auditWriter: AuditWriter;
  rateLimiter: RateLimitService;
  userRepo: IUserRepo;
  personalSubscriptionRepo: IPersonalSubscriptionRepo;
  planRepo: IPlanRepo;
  membershipRepo: IMembershipRepo;
  organizationRepo: IOrganizationRepo;
  syncStateRepo: ISyncStateRepo;
  syncRecordRepo: ISyncRecordRepo;
  /** 只读 Queryable（同步概览聚合走连接池读；非事务）。 */
  db: Queryable;
}

function requestIdOf(req: FastifyRequest): string {
  return (req as unknown as { requestId?: string }).requestId ?? 'unknown';
}

/** 控制台数据面（切片 3）：同步概览 + 组织成员（最小化邮箱披露 + 受限读审计）。 */
export async function consoleDataRoutes(app: FastifyInstance, opts: ConsoleDataRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    routes: async (child) => {
      // 同步概览（§6）：仅聚合元数据，不返回任何 record/密文/E2EE 材料。
      child.get('/api/console/sync/overview', async (req, reply) => {
        const userId = (req as unknown as { authUserId: number }).authUserId;
        await opts.rateLimiter.hit(`console:sync-overview:${userId}`, 60, 30);
        const state = await opts.syncStateRepo.findByUserId(userId);
        if (!state) {
          return reply.send({
            initialized: false,
            lastActivityTime: null,
            activeRecordCount: 0,
            ciphertextBytes: 0,
            recordLimit: null,
            storageLimit: null,
          });
        }
        const overview = await opts.syncRecordRepo.overview(opts.db, userId, state.keyEpoch);
        const sub = await opts.personalSubscriptionRepo.findByUserId(userId);
        const plan = sub ? await opts.planRepo.findById(sub.planId) : undefined;
        const freePlan = await opts.planRepo.findByCode('free');
        const snap = deriveEntitlement(sub, plan, freePlan);
        const recordLimit = normalizeQuota(snap.maxConnectionMetas);
        const storageLimit = normalizeQuota(snap.syncStorageBytes);
        return reply.send({
          initialized: true,
          lastActivityTime: overview.lastActivityTime ? overview.lastActivityTime.toISOString() : null,
          activeRecordCount: overview.count,
          ciphertextBytes: overview.bytes,
          recordLimit,
          storageLimit,
        });
      });

      // 组织成员（§6）：active org + active membership；member 无 email；admin 可见 email 并写受限读审计。
      child.get('/api/console/organizations/:organizationId/members', { schema: { params: organizationIdParam } }, async (req, reply) => {
        const userId = (req as unknown as { authUserId: number }).authUserId;
        const organizationId = Number((req.params as Record<string, unknown>).organizationId);
        await opts.rateLimiter.hit(`console:org-members:${userId}`, 60, 60);

        const org = await opts.organizationRepo.findById(organizationId);
        if (!org || org.status !== 'active') {
          return rejectConsole(reply, 404, 'ORGANIZATION_NOT_FOUND', 'not found');
        }
        const membership = await opts.membershipRepo.findByOrgAndUser(organizationId, userId);
        if (!membership || membership.status !== 'active') {
          return rejectConsole(reply, 404, 'ORGANIZATION_NOT_FOUND', 'not found');
        }

        const members = await opts.membershipRepo.listByOrganization(organizationId);
        const isAdmin = membership.role === 'admin';

        if (!isAdmin) {
          return reply.send({
            members: members.map((m) => ({
              membershipId: String(m.membershipId),
              userId: String(m.userId),
              displayName: m.displayName ?? null,
              role: m.role,
              status: m.status,
              joinedTime: m.joinedTime ? m.joinedTime.toISOString() : null,
            })),
          });
        }

        const emails = new Map<number, string | null>();
        for (const m of members) {
          emails.set(m.userId, (await opts.userRepo.findById(m.userId))?.email ?? null);
        }
        opts.auditWriter.write({
          eventType: 'organization.member_email.read',
          result: 'success',
          actorUserId: userId,
          targetType: 'organization',
          targetId: String(organizationId),
          sourceIp: req.ip,
          requestId: requestIdOf(req),
        });
        return reply.send({
          members: members.map((m) => ({
            membershipId: String(m.membershipId),
            userId: String(m.userId),
            displayName: m.displayName ?? null,
            role: m.role,
            status: m.status,
            joinedTime: m.joinedTime ? m.joinedTime.toISOString() : null,
            email: emails.get(m.userId) ?? null,
          })),
        });
      });
    },
  });
}

/** 配额 0 = 不限 → null（§6）。非数值按 null。 */
function normalizeQuota(v: unknown): number | null {
  if (typeof v !== 'number' || v === 0) return null;
  return v;
}