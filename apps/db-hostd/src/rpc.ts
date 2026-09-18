import { SyncClient } from '@devkit/db-host/sync/syncClient';
import { DekStore, generateDek } from '@devkit/db-host/sync/crypto/keyStore';
import { decodeBase64Url, encodeBase64Url } from '@devkit/db-host/sync/crypto/recoveryCode';
import {
  buildRecordSigningInput,
  buildStateSigningInput,
  signSigningInput,
  SYNC_DOMAIN,
  type SyncAction,
} from '@devkit/db-host/sync/crypto/sign';
import { requestDigestOf } from '@devkit/db-host/sync/crypto/digest';
import { allowedEngines, type CachedEntitlement } from '@devkit/db-host/sync/entitlementGate';
import type { MementoLike } from '@devkit/db-host/sync/e2e/stateStore';
import type { SecureStorageLike } from '@devkit/db-host';

/** 逐行 NDJSON 之上的极简 JSON-RPC（无批处理/无通知：一行一请求一响应）。 */
export interface RpcRequest {
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcSuccess {
  id: string | number | null;
  result: unknown;
}

export interface RpcFailure {
  id: string | number | null;
  error: { code: number; message: string };
}

export type RpcResponse = RpcSuccess | RpcFailure;

export type RpcHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;
export type HandlerMap = Record<string, RpcHandler>;

export interface HandlerDeps {
  secrets: SecureStorageLike;
  memento: MementoLike;
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`param "${key}" must be a non-empty string`);
  return v;
}

function epoch(params: Record<string, unknown>): bigint {
  const v = params.keyEpoch;
  if (typeof v === 'string' || typeof v === 'number') return BigInt(v);
  throw new Error('param "keyEpoch" must be a decimal string or number');
}

/** 把 db-host 的能力暴露为可离线测试的 RPC 方法。 */
export function createHandlers(deps: HandlerDeps): HandlerMap {
  const dek = new DekStore(deps.secrets);

  return {
    ping: () => 'pong',

    'dek.generate': () => ({ dek: encodeBase64Url(generateDek()) }),

    'dek.store': async (p) => {
      await dek.store(str(p, 'userId'), epoch(p), decodeBase64Url(str(p, 'dek')));
      return { ok: true };
    },

    'dek.load': async (p) => {
      const value = await dek.load(str(p, 'userId'), epoch(p));
      return value ? { dek: encodeBase64Url(value) } : { dek: null };
    },

    'dek.delete': async (p) => {
      await dek.delete(str(p, 'userId'), epoch(p));
      return { ok: true };
    },

    'entitlement.allowedEngines': (p) => ({
      engines: allowedEngines(p.entitlement as CachedEntitlement | undefined),
      domain: SYNC_DOMAIN,
    }),

    'sign.requestDigest': (p) => ({ digest: requestDigestOf(p.body) }),

    'sign.stateInput': (p) => ({
      input: buildStateSigningInput(str(p, 'action') as SyncAction as never, {
        userId: str(p, 'userId'),
        keyEpoch: str(p, 'keyEpoch'),
        expectedStateVersion: str(p, 'expectedStateVersion'),
        mutationId: str(p, 'mutationId'),
        requestDigest: str(p, 'requestDigest'),
      }),
    }),

    'sign.recordInput': (p) => ({
      input: buildRecordSigningInput(str(p, 'action') as never, {
        userId: str(p, 'userId'),
        keyEpoch: str(p, 'keyEpoch'),
        recordId: str(p, 'recordId'),
        baseVersion: str(p, 'baseVersion'),
        mutationId: str(p, 'mutationId'),
        requestDigest: str(p, 'requestDigest'),
      }),
    }),

    'sign.signInput': (p) => {
      const action = str(p, 'action');
      const common = {
        userId: str(p, 'userId'),
        keyEpoch: str(p, 'keyEpoch'),
        mutationId: str(p, 'mutationId'),
        requestDigest: str(p, 'requestDigest'),
      };
      const input = action.startsWith('record.')
        ? buildRecordSigningInput(action as never, {
            ...common,
            recordId: str(p, 'recordId'),
            baseVersion: str(p, 'baseVersion'),
          })
        : buildStateSigningInput(action as never, {
            ...common,
            expectedStateVersion: str(p, 'expectedStateVersion'),
          });
      return { signature: signSigningInput(input, decodeBase64Url(str(p, 'dek'))) };
    },

    'sync.getMe': async (p) => {
      const accessToken = typeof p.accessToken === 'string' ? p.accessToken : undefined;
      const refreshToken = typeof p.refreshToken === 'string' ? p.refreshToken : undefined;
      const client = new SyncClient(str(p, 'baseUrl'), () => accessToken, () => refreshToken);
      return client.getMe();
    },
  };
}

/** 分发一条请求；业务异常统一转为 `RpcFailure`，不抛出。 */
export async function dispatch(handlers: HandlerMap, req: RpcRequest): Promise<RpcResponse> {
  const id = req?.id ?? null;
  try {
    if (!req || typeof req.method !== 'string') throw new Error('invalid request: "method" is required');
    const handler = handlers[req.method];
    if (!handler) throw new Error(`unknown method: ${req.method}`);
    const result = await handler(req.params ?? {});
    return { id, result };
  } catch (err) {
    return { id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } };
  }
}