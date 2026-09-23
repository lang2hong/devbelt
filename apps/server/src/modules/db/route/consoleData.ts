import type { FastifyInstance } from 'fastify';
import { consoleSession } from '../../../middleware/requireAuth.js';
import { registerConsoleErrorHandler } from '../../../middleware/consoleError.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { GetAuthUser } from '../../../middleware/requireAuth.js';
import type {
  IUserRepo,
  IPersonalSubscriptionRepo,
  IPlanRepo,
  ISyncStateRepo,
  ISyncRecordRepo,
} from '../../../repository/interfaces.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import { deriveEntitlement } from '../../billing/service/entitlement.js';

export interface ConsoleDataRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  auditWriter: AuditWriter;
  rateLimiter: RateLimitService;
  userRepo: IUserRepo;
  personalSubscriptionRepo: IPersonalSubscriptionRepo;
  planRepo: IPlanRepo;
  syncStateRepo: ISyncStateRepo;
  syncRecordRepo: ISyncRecordRepo;
  /** 只读 Queryable（同步概览聚合走连接池读；非事务）。 */
  db: Queryable;
}

/** 控制台数据面（切片 3）：同步概览。 */
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
      child.get('/api/db/console/sync/overview', async (req, reply) => {
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
    },
  });
}

/** 配额 0 = 不限 → null（§6）。非数值按 null。 */
function normalizeQuota(v: unknown): number | null {
  if (typeof v !== 'number' || v === 0) return null;
  return v;
}