import type { SyncClient } from '../syncClient';
import { requestDigestOf } from '../crypto/digest';
import { buildRecordSigningInput, buildStateSigningInput, signSigningInput, type SyncAction } from '../crypto/sign';
import { assertB64UrlLen, assertU64Decimal, type NewStateDto } from './types';

/**
 * 个人同步 V3 协议客户端（10 个路由，5 个需签名）。
 *
 * 独立于 V2 分节 `SyncClient`（并存期未决 #4）：仅复用其 `requestRaw` 的
 * 鉴权/401 单飞刷新能力。本层只交付协议方法与签名/摘要原语，不持有本地
 * epoch/nonce/状态机，也不管理签名 seed 的生命周期（由 B3 传入）。
 *
 * 重试策略（§8.1.8 / 服务端 receipt）：
 *  - 默认自动重试 5xx：GET state/records、5 个签名 mutation（同 mutationId +
 *    requestDigest + signature 幂等重放由 receipt 保证）。
 *  - 禁止自动重试：PUT init、POST reset-after-loss（无 receipt，重放会得到
 *    SYNC_STATE_EXISTS / 失效 reset token，误报成功为失败）。
 *  - reset-challenges 202 同形，保留默认重试（服务端 3/时 限流语义）。
 */

export class SyncApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
    message?: string,
  ) {
    super(message || `sync API error ${status}${code ? ` [${code}]` : ''}`);
    this.name = 'SyncApiError';
  }
}

export interface MutateOptsBase {
  userId: string;
  keyEpoch: string;
  mutationId: string;
  seed: Uint8Array;
}

export interface PutRecordOpts extends MutateOptsBase {
  recordId: string;
  baseVersion: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface DeleteRecordOpts extends MutateOptsBase {
  recordId: string;
  baseVersion: string;
}

export interface ChangeKeyOpts extends MutateOptsBase {
  expectedStateVersion: string;
  smpKdf: unknown;
  envelopeSmp: unknown;
}

export interface RecoverOpts extends MutateOptsBase {
  expectedStateVersion: string;
  smpKdf: unknown;
  envelopeSmp: unknown;
  recoveryKdf: unknown;
  envelopeRecovery: unknown;
  recoverSignPub: string;
}

export interface DestroyOpts extends MutateOptsBase {
  expectedStateVersion: string;
  newState: NewStateDto;
}

export class V3SyncClient {
  constructor(private readonly http: SyncClient) {}

  // ── 无签名 ──

  getState(): Promise<unknown> {
    return this.call('GET', '/api/sync/state');
  }

  init(newState: NewStateDto): Promise<unknown> {
    return this.call('PUT', '/api/sync/init', { newState }, { retry: false });
  }

  getRecords(after: string, snapshotSequence: string | undefined, limit: number): Promise<unknown> {
    assertU64Decimal(after, 'after', true);
    if (snapshotSequence !== undefined) assertU64Decimal(snapshotSequence, 'snapshotSequence');
    const q = new URLSearchParams();
    if (after !== '0') q.set('after', after);
    if (snapshotSequence !== undefined) q.set('snapshotSequence', snapshotSequence);
    q.set('limit', String(limit));
    return this.call('GET', `/api/sync/records?${q.toString()}`);
  }

  resetChallenges(): Promise<unknown> {
    return this.call('POST', '/api/sync/reset-challenges');
  }

  resetAfterLoss(resetToken: string, newState: NewStateDto): Promise<unknown> {
    assertB64UrlLen(resetToken, 32, 'resetToken');
    return this.call(
      'POST',
      '/api/sync/reset-after-loss',
      { protocolVersion: 1, resetToken, confirmIrreversible: true, confirmDataLoss: true, confirmNoRecovery: true, newState },
      { retry: false },
    );
  }

  // ── 签名 mutation ──

  async putRecord(o: PutRecordOpts): Promise<unknown> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.baseVersion, 'baseVersion', true);
    assertB64UrlLen(o.mutationId, 16, 'mutationId');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      recordId: o.recordId,
      baseVersion: o.baseVersion,
      cipherSuite: 'AES-256-GCM',
      formatVersion: 1,
      nonce: o.nonce,
      ciphertext: o.ciphertext,
      tag: o.tag,
    };
    const signature = this.signMutation('record.put', { ...o }, body);
    body.signature = signature;
    return this.call('PUT', `/api/sync/records/${encodeURIComponent(o.recordId)}`, body);
  }

  async deleteRecord(o: DeleteRecordOpts): Promise<unknown> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.baseVersion, 'baseVersion');
    assertB64UrlLen(o.mutationId, 16, 'mutationId');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      recordId: o.recordId,
      baseVersion: o.baseVersion,
    };
    const signature = this.signMutation('record.delete', { ...o }, body);
    body.signature = signature;
    return this.call('DELETE', `/api/sync/records/${encodeURIComponent(o.recordId)}`, body);
  }

  async changeKey(o: ChangeKeyOpts): Promise<unknown> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.expectedStateVersion, 'expectedStateVersion');
    assertB64UrlLen(o.mutationId, 16, 'mutationId');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      expectedStateVersion: o.expectedStateVersion,
      smpKdf: o.smpKdf,
      envelopeSmp: o.envelopeSmp,
    };
    const signature = this.signMutation('state.change-key', { ...o }, body);
    body.signature = signature;
    return this.call('POST', '/api/sync/change-key', body);
  }

  async recover(o: RecoverOpts): Promise<unknown> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.expectedStateVersion, 'expectedStateVersion');
    assertB64UrlLen(o.mutationId, 16, 'mutationId');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      expectedStateVersion: o.expectedStateVersion,
      smpKdf: o.smpKdf,
      envelopeSmp: o.envelopeSmp,
      recoveryKdf: o.recoveryKdf,
      envelopeRecovery: o.envelopeRecovery,
      recoverSignPub: o.recoverSignPub,
    };
    const signature = this.signMutation('state.recover', { ...o }, body);
    body.signature = signature;
    return this.call('POST', '/api/sync/recover', body);
  }

  async destroy(o: DestroyOpts): Promise<unknown> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.expectedStateVersion, 'expectedStateVersion');
    assertB64UrlLen(o.mutationId, 16, 'mutationId');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      expectedStateVersion: o.expectedStateVersion,
      newState: o.newState,
    };
    const signature = this.signMutation('state.destroy', { ...o }, body);
    body.signature = signature;
    return this.call('POST', '/api/sync/destroy', body);
  }

  /**
   * requestDigest 顺序锚点：从「实际发送 body（尚未附 signature）」算 digest →
   * 构造 signingInput（含 digest）→ 签名。绝不把 signature 算进自己的 digest。
   */
  private signMutation(action: SyncAction, o: { userId: string; keyEpoch: string; mutationId: string; seed: Uint8Array }, body: Record<string, unknown>): string {
    const requestDigest = requestDigestOf(body);
    const common = { userId: o.userId, keyEpoch: o.keyEpoch, mutationId: o.mutationId, requestDigest };
    const input = action === 'record.put' || action === 'record.delete'
      ? buildRecordSigningInput(action, { ...common, recordId: (body.recordId as string), baseVersion: (body.baseVersion as string) })
      : buildStateSigningInput(action, { ...common, expectedStateVersion: (body.expectedStateVersion as string) });
    return signSigningInput(input, o.seed);
  }

  private async call(method: string, path: string, body?: unknown, opts?: { retry?: boolean }): Promise<unknown> {
    const res = await this.http.requestRaw(method, path, body, opts);
    if (res.status >= 200 && res.status < 300) return res.body;
    const b = (res.body ?? {}) as { code?: string; message?: string };
    throw new SyncApiError(res.status, b.code, b.message);
  }
}