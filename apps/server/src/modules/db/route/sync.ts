import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../../../middleware/requireAuth.js';
import type { TokenService } from '../../../service/tokenService.js';
import { sendError } from '../../../middleware/errorHandler.js';
import { requestDigestOf, decodeB64Url, decodeB64UrlRange, jcs, sha256 } from '../service/syncCrypto.js';
import { SyncProtocolUnsupportedError } from '../../../domain/errors.js';
import {
  SyncStateService,
  type SyncNewState,
} from '../service/syncStateService.js';
import { SyncRecordService } from '../service/syncRecordService.js';
import { SyncResetService } from '../service/syncResetService.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { SmpKdf, RecoveryKdf, SyncEnvelope } from '../../../domain/entities.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import type { EmailSender } from '../../auth/service/emailSender.js';
import type { IUserRepo } from '../../../repository/interfaces.js';
import {
  syncInitBody,
  syncChangeKeyBody,
  syncRecoverBody,
  syncDestroyBody,
  syncAccountRecoverBody,
  syncRecoverViaAccountBody,
  syncPutRecordBody,
  syncDeleteRecordBody,
  syncRecordIdParam,
  syncRecordsQuery,
  syncResetAfterLossBody,
} from '../../../route/schemas.js';

export interface SyncRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  syncState: SyncStateService;
  syncRecord: SyncRecordService;
  syncReset: SyncResetService;
  rateLimiter: RateLimitService;
  /** 账号恢复 step-up：复核账户登录口令（任意 sync token 不得单凭待解码材料）。 */
  verifyAccountRecoveryPassword: (userId: number, password: string) => Promise<void>;
  auditWriter?: AuditWriter;
  /** 账号恢复材料下发后的安全通知投递（无 token/材料/口令），失败不阻断恢复。 */
  emailSender?: EmailSender;
  /** 安全通知收件人：查账户已验证邮箱（未验证则静默不发，与 reset-challenge 一致）。 */
  userRepo?: IUserRepo;
}

/**
 * 个人 E2EE 写端点按风险分桶限流（§8）。有效 access token 可持续消耗签名验证、
 * 数据库事务与存储配额，故写路径必须有按用户限流；读路径（state/records）仅返回
 * 少量元数据，不设写桶。reset-challenges 已在服务层按 user+IP 每小时 3 次限流。
 */
const SYNC_INIT_WINDOW_S = 3600;
const SYNC_INIT_MAX = 10;
const SYNC_KEYS_WINDOW_S = 3600;
const SYNC_KEYS_MAX = 20;
const SYNC_RECORD_WINDOW_S = 60;
const SYNC_RECORD_MAX = 600;
const SYNC_RESET_WINDOW_S = 3600;
const SYNC_RESET_MAX = 10;
/** 账号恢复 step-up 口令的按用户限流（每次尝试计数），防止 token 泄露者离线撞库。 */
const SYNC_ACCOUNT_RECOVERY_STEPUP_WINDOW_S = 3600;
const SYNC_ACCOUNT_RECOVERY_STEPUP_MAX = 5;

/** 协议/cipher/format 值域由服务层判定（§8：不在支持集 → 400 SYNC_PROTOCOL_UNSUPPORTED）。 */
function assertProtocolV1(protocolVersion: unknown): void {
  if (protocolVersion !== 1) throw new SyncProtocolUnsupportedError();
}

function decodeEnvelope(e: any): SyncEnvelope {
  if (e.protocolVersion !== 1 || e.cipherSuite !== 'AES-256-GCM' || e.formatVersion !== 1) {
    throw new SyncProtocolUnsupportedError();
  }
  return {
    version: e.envelopeVersion,
    nonce: decodeB64Url(e.nonce, 12, 'envelope.nonce'),
    ct: decodeB64Url(e.ciphertext, 32, 'envelope.ciphertext'),
    tag: decodeB64Url(e.tag, 16, 'envelope.tag'),
  };
}

function decodeSmpKdf(k: any): SmpKdf {
  return {
    alg: 'argon2id', version: 1,
    memoryKiB: k.memoryKiB, iterations: k.iterations, parallelism: k.parallelism,
    salt: decodeB64Url(k.salt, 16, 'smpKdf.salt'), outputBytes: 32,
  };
}

function decodeRecoveryKdf(k: any): RecoveryKdf {
  return { alg: 'hkdf-sha256', version: 1, salt: decodeB64Url(k.salt, 16, 'recoveryKdf.salt'), outputBytes: 32 };
}

function decodeNewState(ns: any): SyncNewState {
  if (ns.protocolVersion !== 1 || ns.cipherSuite !== 'AES-256-GCM' || ns.formatVersion !== 1) {
    throw new SyncProtocolUnsupportedError();
  }
  return {
    protocolVersion: ns.protocolVersion,
    cipherSuite: ns.cipherSuite,
    formatVersion: ns.formatVersion,
    smpKdf: decodeSmpKdf(ns.smpKdf),
    recoveryKdf: decodeRecoveryKdf(ns.recoveryKdf),
    envelopeSmp: decodeEnvelope(ns.envelopeSmp),
    envelopeRecovery: decodeEnvelope(ns.envelopeRecovery),
    envelopeAccount: decodeEnvelope(ns.envelopeAccount),
    accountRecoveryKey: decodeB64Url(ns.accountRecoveryKey, 32, 'accountRecoveryKey'),
    signPub: decodeB64Url(ns.signPub, 32, 'signPub'),
    recoverSignPub: decodeB64Url(ns.recoverSignPub, 32, 'recoverSignPub'),
  };
}

/** 账号恢复材料出站序列化（base64url）。 */
function accountRecoveryDto(r: { accountRecoveryKey: Buffer; envelopeAccount: SyncEnvelope }) {
  return {
    accountRecoveryKey: r.accountRecoveryKey.toString('base64url'),
    envelopeAccount: {
      protocolVersion: 1,
      cipherSuite: 'AES-256-GCM',
      formatVersion: 1,
      envelopeVersion: r.envelopeAccount.version,
      nonce: r.envelopeAccount.nonce.toString('base64url'),
      ciphertext: r.envelopeAccount.ct.toString('base64url'),
      tag: r.envelopeAccount.tag.toString('base64url'),
    },
  };
}

/** requestDigest = SHA-256(JCS(body 除 signature))，见 §7.4。 */
function digestOf(body: Record<string, unknown>): string {
  const withoutSig: Record<string, unknown> = { ...body };
  delete withoutSig.signature;
  return requestDigestOf(withoutSig);
}

/**
 * 账号恢复材料下发后的安全通知：向账户的已验证邮箱投递「恢复刚被访问」提醒。
 * - 只发已验证邮箱（未验证则静默跳过），与 reset-challenge 一致，避免打扰不可达地址。
 * - 通知不含任何 token / 恢复材料 / 口令 / 链接；失败仅记日志，绝不阻断恢复响应或回滚结果。
 */
async function notifyAccountRecoveryActivity(
  emailSender: EmailSender | undefined,
  userRepo: IUserRepo | undefined,
  userId: number,
): Promise<void> {
  if (!emailSender || !userRepo) return;
  let user;
  try {
    user = await userRepo.findById(userId);
  } catch {
    return;
  }
  if (!user || !user.email || !user.emailVerifiedTime) return;
  try {
    await emailSender.sendAccountRecoveryActivityEmail({ to: user.email, displayName: user.displayName });
  } catch (err) {
    console.warn('[sync] account recovery activity email failed', { err: String(err) });
  }
}

/** 个人 E2E 同步状态侧路由（§7.5：GET state / PUT init / POST change-key·recover·destroy）。 */
export async function syncRoutes(app: FastifyInstance, opts: SyncRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    // 个人 E2E 同步仅限扩展 audience（§4.1：浏览器不得接触 E2EE 材料）。
    aud: 'extension',
    scope: ['sync'],
    routes: async (child) => {
      const initLimit = (userId: number) => opts.rateLimiter.hit(`sync:init:user:${userId}`, SYNC_INIT_WINDOW_S, SYNC_INIT_MAX);
      const keysLimit = (userId: number) => opts.rateLimiter.hit(`sync:keys:user:${userId}`, SYNC_KEYS_WINDOW_S, SYNC_KEYS_MAX);
      const recordLimit = (userId: number) => opts.rateLimiter.hit(`sync:record:user:${userId}`, SYNC_RECORD_WINDOW_S, SYNC_RECORD_MAX);
      const resetLimit = (userId: number) => opts.rateLimiter.hit(`sync:reset:user:${userId}`, SYNC_RESET_WINDOW_S, SYNC_RESET_MAX);
      const accountRecoveryStepUpLimit = (userId: number) => opts.rateLimiter.hit(`sync:account-recovery-stepup:user:${userId}`, SYNC_ACCOUNT_RECOVERY_STEPUP_WINDOW_S, SYNC_ACCOUNT_RECOVERY_STEPUP_MAX);

      child.get('/api/db/sync/state', async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          reply.send(await opts.syncState.getState(userId));
        } catch (e) { sendError(reply, e); }
      });

      child.put('/api/db/sync/init', { schema: { body: syncInitBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          await initLimit(userId);
          await opts.syncState.init(userId, decodeNewState((req.body as any).newState));
          reply.code(201).send();
        } catch (e) { sendError(reply, e); }
      });

      child.post('/api/db/sync/change-key', { schema: { body: syncChangeKeyBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
          await keysLimit(userId);
          assertProtocolV1(body.protocolVersion);
          reply.send(await opts.syncState.changeKey(userId, {
            keyEpoch: body.keyEpoch,
            mutationId: body.mutationId,
            signature: decodeB64Url(body.signature, 64, 'signature'),
            expectedStateVersion: body.expectedStateVersion,
            requestDigest: digestOf(body),
            smpKdf: decodeSmpKdf(body.smpKdf),
            envelopeSmp: decodeEnvelope(body.envelopeSmp),
          }));
        } catch (e) { sendError(reply, e); }
      });

      child.post('/api/db/sync/recover', { schema: { body: syncRecoverBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
          await keysLimit(userId);
          assertProtocolV1(body.protocolVersion);
          reply.send(await opts.syncState.recover(userId, {
            keyEpoch: body.keyEpoch,
            mutationId: body.mutationId,
            signature: decodeB64Url(body.signature, 64, 'signature'),
            expectedStateVersion: body.expectedStateVersion,
            requestDigest: digestOf(body),
            smpKdf: decodeSmpKdf(body.smpKdf),
            envelopeSmp: decodeEnvelope(body.envelopeSmp),
            recoveryKdf: decodeRecoveryKdf(body.recoveryKdf),
            envelopeRecovery: decodeEnvelope(body.envelopeRecovery),
            recoverSignPub: decodeB64Url(body.recoverSignPub, 32, 'recoverSignPub'),
          }));
        } catch (e) { sendError(reply, e); }
      });

      child.post('/api/db/sync/destroy', { schema: { body: syncDestroyBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
          await keysLimit(userId);
          assertProtocolV1(body.protocolVersion);
          reply.send(await opts.syncState.destroy(userId, {
            keyEpoch: body.keyEpoch,
            mutationId: body.mutationId,
            signature: decodeB64Url(body.signature, 64, 'signature'),
            expectedStateVersion: body.expectedStateVersion,
            requestDigest: digestOf(body),
            newState: decodeNewState(body.newState),
          }));
        } catch (e) { sendError(reply, e); }
      });

      child.post('/api/db/sync/recover-via-account', { schema: { body: syncRecoverViaAccountBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
          // 该端点下发 DEK 解密原材料，安全边界不能只靠一个普通 sync token：
          // 先在按用户限流内复核账户登录口令（step-up），失败不计入下发路径并落审计。
          await accountRecoveryStepUpLimit(userId);
          try {
            await opts.verifyAccountRecoveryPassword(userId, body.password);
          } catch (e) {
            opts.auditWriter?.write({
              eventType: 'sync.account.recovery.material_failed',
              result: 'failure',
              failureCode: (e as { code?: string })?.code ?? null,
              actorUserId: userId,
              targetType: 'sync_state',
              sourceIp: req.ip,
            });
            throw e;
          }
          const material = await opts.syncState.recoverViaAccount(userId);
          opts.auditWriter?.write({
            eventType: 'sync.account.recovery.material_released',
            result: 'success',
            actorUserId: userId,
            targetType: 'sync_state',
            sourceIp: req.ip,
          });
          // 安全通知：材料已下发，异步提醒账户所有者（helper 已吞掉所有异常，失败不阻断、不回滚已审计的成功结果）。
          void notifyAccountRecoveryActivity(opts.emailSender, opts.userRepo, userId);
          reply.send(accountRecoveryDto(material));
        } catch (e) { sendError(reply, e); }
      });

      child.post('/api/db/sync/account-recover', { schema: { body: syncAccountRecoverBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
          // 限流在服务层（回执优先于限流）：此处不再前置 keysLimit，否则「已提交 + 响应丢失」的
          // 重放会在配额边界被 429 拦截而无法命中回执，导致恢复码误丢。
          assertProtocolV1(body.protocolVersion);
          reply.send(await opts.syncState.recoverByAccount(userId, {
            keyEpoch: body.keyEpoch,
            mutationId: body.mutationId,
            signature: decodeB64Url(body.signature, 64, 'signature'),
            expectedStateVersion: body.expectedStateVersion,
            requestDigest: digestOf(body),
            smpKdf: decodeSmpKdf(body.smpKdf),
            envelopeSmp: decodeEnvelope(body.envelopeSmp),
            recoveryKdf: decodeRecoveryKdf(body.recoveryKdf),
            envelopeRecovery: decodeEnvelope(body.envelopeRecovery),
            envelopeAccount: decodeEnvelope(body.envelopeAccount),
            accountRecoveryKey: decodeB64Url(body.accountRecoveryKey, 32, 'accountRecoveryKey'),
            recoverSignPub: decodeB64Url(body.recoverSignPub, 32, 'recoverSignPub'),
          }));
        } catch (e) { sendError(reply, e); }
      });

      child.get('/api/db/sync/records', { schema: { querystring: syncRecordsQuery } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const q = (req.query ?? {}) as Record<string, unknown>;
        const after = typeof q.after === 'string' ? q.after : '0';
        const snapshotSequence = typeof q.snapshotSequence === 'string' ? q.snapshotSequence : undefined;
        const limit = typeof q.limit === 'number' ? q.limit : 256;
        try {
          reply.send(await opts.syncRecord.pull(userId, after, snapshotSequence, limit));
        } catch (e) { sendError(reply, e); }
      });

      child.put('/api/db/sync/records/:recordId', { schema: { params: syncRecordIdParam, body: syncPutRecordBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        const pathId = (req.params as any).recordId as string;
        if (pathId !== body.recordId) {
          return reply.code(400).send({ message: 'validation failed', code: 'VALIDATION_FAILED' });
        }
        try {
          await recordLimit(userId);
          assertProtocolV1(body.protocolVersion);
          if (body.cipherSuite !== 'AES-256-GCM' || body.formatVersion !== 1) throw new SyncProtocolUnsupportedError();
          reply.send(await opts.syncRecord.putRecord(userId, {
            keyEpoch: body.keyEpoch,
            mutationId: body.mutationId,
            signature: decodeB64Url(body.signature, 64, 'signature'),
            baseVersion: body.baseVersion,
            requestDigest: digestOf(body),
            recordId: body.recordId,
            cipherSuite: body.cipherSuite,
            formatVersion: body.formatVersion,
            nonce: decodeB64Url(body.nonce, 12, 'nonce'),
            ciphertext: decodeB64UrlRange(body.ciphertext, 1, 256 * 1024, 'ciphertext'),
            tag: decodeB64Url(body.tag, 16, 'tag'),
            entityKind: typeof body.entityKind === 'string' ? body.entityKind : undefined,
          }));
        } catch (e) { sendError(reply, e); }
      });

      child.delete('/api/db/sync/records/:recordId', { schema: { params: syncRecordIdParam, body: syncDeleteRecordBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        const pathId = (req.params as any).recordId as string;
        if (pathId !== body.recordId) {
          return reply.code(400).send({ message: 'validation failed', code: 'VALIDATION_FAILED' });
        }
        try {
          await recordLimit(userId);
          assertProtocolV1(body.protocolVersion);
          reply.send(await opts.syncRecord.deleteRecord(userId, {
            keyEpoch: body.keyEpoch,
            mutationId: body.mutationId,
            signature: decodeB64Url(body.signature, 64, 'signature'),
            baseVersion: body.baseVersion,
            requestDigest: digestOf(body),
            recordId: body.recordId,
          }));
        } catch (e) { sendError(reply, e); }
      });

      child.post('/api/db/sync/reset-challenges', async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          await opts.syncReset.requestResetChallenge(userId, req.ip);
          reply.code(202).send();
        } catch (e) { sendError(reply, e); }
      });

      child.post('/api/db/sync/reset-after-loss', { schema: { body: syncResetAfterLossBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
          await resetLimit(userId);
          // request_digest 覆盖客户端提交的 newState（JCS），completed 回放比对用。
          reply.send(await opts.syncReset.resetAfterLossWithHandoff(userId, {
            handoffTicket: decodeB64Url(body.handoffTicket, 32, 'handoffTicket'),
            newState: decodeNewState(body.newState),
            requestDigest: sha256(Buffer.from(jcs({ newState: body.newState }), 'utf8')),
          }));
        } catch (e) { sendError(reply, e); }
      });
    },
  });
}
