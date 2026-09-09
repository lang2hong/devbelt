import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import type { TokenService } from '../service/tokenService.js';
import { sendError } from '../middleware/errorHandler.js';
import { requestDigestOf, decodeB64Url, decodeB64UrlRange, jcs, sha256 } from '../service/syncCrypto.js';
import { SyncProtocolUnsupportedError } from '../domain/errors.js';
import {
  SyncStateService,
  type SyncNewState,
} from '../service/syncStateService.js';
import { SyncRecordService } from '../service/syncRecordService.js';
import { SyncResetService } from '../service/syncResetService.js';
import type { SmpKdf, RecoveryKdf, SyncEnvelope } from '../domain/entities.js';
import {
  syncInitBody,
  syncChangeKeyBody,
  syncRecoverBody,
  syncDestroyBody,
  syncPutRecordBody,
  syncDeleteRecordBody,
  syncRecordIdParam,
  syncRecordsQuery,
  syncResetAfterLossBody,
} from './schemas.js';

export interface SyncRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  syncState: SyncStateService;
  syncRecord: SyncRecordService;
  syncReset: SyncResetService;
}

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
    signPub: decodeB64Url(ns.signPub, 32, 'signPub'),
    recoverSignPub: decodeB64Url(ns.recoverSignPub, 32, 'recoverSignPub'),
  };
}

/** requestDigest = SHA-256(JCS(body 除 signature))，见 §7.4。 */
function digestOf(body: Record<string, unknown>): string {
  const withoutSig: Record<string, unknown> = { ...body };
  delete withoutSig.signature;
  return requestDigestOf(withoutSig);
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
      child.get('/api/sync/state', async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          reply.send(await opts.syncState.getState(userId));
        } catch (e) { sendError(reply, e); }
      });

      child.put('/api/sync/init', { schema: { body: syncInitBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          await opts.syncState.init(userId, decodeNewState((req.body as any).newState));
          reply.code(201).send();
        } catch (e) { sendError(reply, e); }
      });

      child.post('/api/sync/change-key', { schema: { body: syncChangeKeyBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
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

      child.post('/api/sync/recover', { schema: { body: syncRecoverBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
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

      child.post('/api/sync/destroy', { schema: { body: syncDestroyBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
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

      child.get('/api/sync/records', { schema: { querystring: syncRecordsQuery } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const q = (req.query ?? {}) as Record<string, unknown>;
        const after = typeof q.after === 'string' ? q.after : '0';
        const snapshotSequence = typeof q.snapshotSequence === 'string' ? q.snapshotSequence : undefined;
        const limit = typeof q.limit === 'number' ? q.limit : 256;
        try {
          reply.send(await opts.syncRecord.pull(userId, after, snapshotSequence, limit));
        } catch (e) { sendError(reply, e); }
      });

      child.put('/api/sync/records/:recordId', { schema: { params: syncRecordIdParam, body: syncPutRecordBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        const pathId = (req.params as any).recordId as string;
        if (pathId !== body.recordId) {
          return reply.code(400).send({ message: 'validation failed', code: 'VALIDATION_FAILED' });
        }
        try {
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
          }));
        } catch (e) { sendError(reply, e); }
      });

      child.delete('/api/sync/records/:recordId', { schema: { params: syncRecordIdParam, body: syncDeleteRecordBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        const pathId = (req.params as any).recordId as string;
        if (pathId !== body.recordId) {
          return reply.code(400).send({ message: 'validation failed', code: 'VALIDATION_FAILED' });
        }
        try {
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

      child.post('/api/sync/reset-challenges', async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          await opts.syncReset.requestResetChallenge(userId, req.ip);
          reply.code(202).send();
        } catch (e) { sendError(reply, e); }
      });

      child.post('/api/sync/reset-after-loss', { schema: { body: syncResetAfterLossBody } }, async (req, reply) => {
        const userId = (req as any).authUserId as number;
        const body = req.body as any;
        try {
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
