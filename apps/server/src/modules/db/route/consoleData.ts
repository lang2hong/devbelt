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
import type { SyncStateService } from '../service/syncStateService.js';
import type { SyncRecordService } from '../service/syncRecordService.js';

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
  /** P6-S5a：console 作用域 E2EE 材料与密文 feed 读取。 */
  syncState: SyncStateService;
  syncRecordService: SyncRecordService;
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
      // P6-S5a：浏览器解锁所需 E2EE 材料（SMP 信封 + KDF 参数 + signPub），**不含 secret**。
      child.get('/api/db/console/sync/e2ee-params', async (req, reply) => {
        const userId = (req as unknown as { authUserId: number }).authUserId;
        await opts.rateLimiter.hit(`console:sync-e2ee-params:${userId}`, 60, 30);
        const state = await opts.syncStateRepo.findByUserId(userId);
        if (!state) return reply.send({ initialized: false });
        const dto = await opts.syncState.getState(userId);
        return reply.send({
          initialized: true,
          protocolVersion: dto.protocolVersion,
          cipherSuite: dto.cipherSuite,
          formatVersion: dto.formatVersion,
          keyEpoch: dto.keyEpoch,
          stateVersion: dto.stateVersion,
          changeSequence: dto.changeSequence,
          signPub: dto.signPub,
          smpKdf: dto.smpKdf,
          envelopeSmp: dto.envelopeSmp,
        });
      });

      // P6-S5a：当前 epoch 的密文 record feed（服务端不解密、无明文）。
      child.get('/api/db/console/sync/records', async (req, reply) => {
        const userId = (req as unknown as { authUserId: number }).authUserId;
        await opts.rateLimiter.hit(`console:sync-records:${userId}`, 120, 30);
        const q = req.query as Record<string, unknown>;
        const after = typeof q.after === 'string' && q.after ? q.after : '0';
        const limitRaw = Number(q.limit ?? 200);
        const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 256) : 200;
        const state = await opts.syncStateRepo.findByUserId(userId);
        if (!state) return reply.send({ initialized: false, snapshotSequence: '0', records: [] });
        const result = await opts.syncRecordService.pull(userId, after, undefined, limit);
        return reply.send({ initialized: true, ...result });
      });

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