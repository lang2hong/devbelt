import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import type { TokenService } from '../service/tokenService.js';
import { sendError } from '../middleware/errorHandler.js';
import { requestDigestOf, decodeB64Url } from '../service/syncCrypto.js';
import {
  SyncStateService,
  type SyncNewState,
} from '../service/syncStateService.js';
import type { SmpKdf, RecoveryKdf, SyncEnvelope } from '../domain/entities.js';
import {
  syncInitBody,
  syncChangeKeyBody,
  syncRecoverBody,
  syncDestroyBody,
} from './schemas.js';

export interface SyncRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  syncState: SyncStateService;
}

function decodeEnvelope(e: any): SyncEnvelope {
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

/** requestDigest = SHA-256(JCS(body 除 signature))，见 §8.1.8。 */
function digestOf(body: Record<string, unknown>): string {
  const withoutSig: Record<string, unknown> = { ...body };
  delete withoutSig.signature;
  return requestDigestOf(withoutSig);
}

/** 个人 E2E 同步状态侧路由（§8.1.7：GET state / PUT init / POST change-key·recover·destroy）。 */
export async function syncRoutes(app: FastifyInstance, opts: SyncRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
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
    },
  });
}