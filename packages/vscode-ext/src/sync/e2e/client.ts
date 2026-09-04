import type { SyncClient } from '../syncClient';
import { requestDigestOf } from '../crypto/digest';
import { buildRecordSigningInput, buildStateSigningInput, signSigningInput, type SyncAction } from '../crypto/sign';
import {
  assertBase64UrlNoPad,
  assertBase64UrlRange,
  assertRecordId,
  assertU64Decimal,
  validateEnvelope,
  validateNewState,
  validateRecoveryKdf,
  validateSmpKdf,
  type EnvelopeDto,
  type NewStateDto,
  type RecoveryKdfDto,
  type SmpKdfDto,
  type StateDto,
} from './types';

/**
 * 个人同步协议客户端（10 个路由，5 个需签名）。
 *
 * 复用 `SyncClient.requestRaw` 的鉴权和 401 单飞刷新能力。本层只提供协议方法与
 * 签名/摘要原语，不持有本地 epoch/nonce/状态机，也不管理签名 seed 生命周期。
 *
 * requestDigest 顺序锚点：从「实际发送 body（尚未附 signature）」构造纯 JSON
 * 冻结对象 → 算 digest → 构造 signingInput（含 digest）→ 签名 → 附 signature。
 *
 * 重试策略：默认自动重试 5xx（GET state/records、5 个签名 mutation 由 receipt
 * 幂等）；init / reset-after-loss 禁止重试（无 receipt，重放误报成功为失败）。
 */

export class SyncApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
    public readonly currentVersion?: string,
    public readonly currentKeyEpoch?: string,
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
  smpKdf: SmpKdfDto;
  envelopeSmp: EnvelopeDto;
}

export interface RecoverOpts extends MutateOptsBase {
  expectedStateVersion: string;
  smpKdf: SmpKdfDto;
  envelopeSmp: EnvelopeDto;
  recoveryKdf: RecoveryKdfDto;
  envelopeRecovery: EnvelopeDto;
  recoverSignPub: string;
}

export interface DestroyOpts extends MutateOptsBase {
  expectedStateVersion: string;
  newState: NewStateDto;
}

/** record put/delete 回执。 */
export interface RecordReceipt {
  version: string;
  changeSequence: string;
}

/** change-key 回执。 */
export interface ChangeKeyResult {
  keyEpoch: string;
  stateVersion: string;
}

/** recover 回执。 */
export interface RecoverResult extends ChangeKeyResult {
  recoveryCodeSetTime: string | null;
}

/** destroy / reset-after-loss 回执：完整三字段快照。 */
export interface DestroyResult {
  keyEpoch: string;
  stateVersion: string;
  changeSequence: string;
}

export class PersonalSyncClient {
  constructor(private readonly http: SyncClient) {}

  // ── 无签名 ──

  getState(): Promise<StateDto> {
    return this.call<StateDto>('GET', '/api/sync/state');
  }

  async init(newState: NewStateDto): Promise<void> {
    return this.call<void>('PUT', '/api/sync/init', { newState: validateNewState(newState) }, { retry: false });
  }

  async getRecords(after: string, snapshotSequence: string | undefined, limit: number): Promise<unknown> {
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

  async resetAfterLoss(resetToken: string, newState: NewStateDto): Promise<DestroyResult> {
    assertBase64UrlNoPad(resetToken, 32, 'resetToken');
    return this.call<DestroyResult>(
      'POST',
      '/api/sync/reset-after-loss',
      {
        protocolVersion: 1,
        resetToken,
        confirmIrreversible: true,
        confirmDataLoss: true,
        confirmNoRecovery: true,
        newState: validateNewState(newState),
      },
      { retry: false },
    );
  }

  // ── 签名 mutation ──

  async putRecord(o: PutRecordOpts): Promise<RecordReceipt> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.baseVersion, 'baseVersion', true);
    assertBase64UrlNoPad(o.mutationId, 16, 'mutationId');
    assertRecordId(o.recordId);
    assertBase64UrlNoPad(o.nonce, 12, 'nonce');
    assertBase64UrlRange(o.ciphertext, 1, 256 * 1024, 'ciphertext');
    assertBase64UrlNoPad(o.tag, 16, 'tag');
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
    body.signature = this.signMutation('record.put', o, body);
    return this.call<RecordReceipt>('PUT', `/api/sync/records/${encodeURIComponent(o.recordId)}`, body);
  }

  async deleteRecord(o: DeleteRecordOpts): Promise<RecordReceipt> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.baseVersion, 'baseVersion');
    assertBase64UrlNoPad(o.mutationId, 16, 'mutationId');
    assertRecordId(o.recordId);
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      recordId: o.recordId,
      baseVersion: o.baseVersion,
    };
    body.signature = this.signMutation('record.delete', o, body);
    return this.call<RecordReceipt>('DELETE', `/api/sync/records/${encodeURIComponent(o.recordId)}`, body);
  }

  // ── 已签名 mutation 直发（重放专用，不做签名，逐字复用持久化 signature/digest）──

  async putRecordSigned(o: {
    keyEpoch: string;
    mutationId: string;
    recordId: string;
    baseVersion: string;
    signature: string;
    requestDigest: string;
    nonce: string;
    ciphertext: string;
    tag: string;
  }): Promise<RecordReceipt> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.baseVersion, 'baseVersion', true);
    assertBase64UrlNoPad(o.mutationId, 16, 'mutationId');
    assertRecordId(o.recordId);
    assertBase64UrlNoPad(o.signature, 64, 'signature');
    assertBase64UrlNoPad(o.requestDigest, 32, 'requestDigest');
    assertBase64UrlNoPad(o.nonce, 12, 'nonce');
    assertBase64UrlRange(o.ciphertext, 1, 256 * 1024, 'ciphertext');
    assertBase64UrlNoPad(o.tag, 16, 'tag');
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
    if (requestDigestOf(body) !== o.requestDigest) throw new Error('outbox mutation digest mismatch');
    body.signature = o.signature;
    return this.call<RecordReceipt>('PUT', `/api/sync/records/${encodeURIComponent(o.recordId)}`, body);
  }

  async deleteRecordSigned(o: {
    keyEpoch: string;
    mutationId: string;
    recordId: string;
    baseVersion: string;
    signature: string;
    requestDigest: string;
  }): Promise<RecordReceipt> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.baseVersion, 'baseVersion');
    assertBase64UrlNoPad(o.mutationId, 16, 'mutationId');
    assertRecordId(o.recordId);
    assertBase64UrlNoPad(o.signature, 64, 'signature');
    assertBase64UrlNoPad(o.requestDigest, 32, 'requestDigest');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      recordId: o.recordId,
      baseVersion: o.baseVersion,
    };
    if (requestDigestOf(body) !== o.requestDigest) throw new Error('outbox mutation digest mismatch');
    body.signature = o.signature;
    return this.call<RecordReceipt>('DELETE', `/api/sync/records/${encodeURIComponent(o.recordId)}`, body);
  }

  async changeKey(o: ChangeKeyOpts): Promise<ChangeKeyResult> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.expectedStateVersion, 'expectedStateVersion');
    assertBase64UrlNoPad(o.mutationId, 16, 'mutationId');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      expectedStateVersion: o.expectedStateVersion,
      smpKdf: validateSmpKdf(o.smpKdf),
      envelopeSmp: validateEnvelope(o.envelopeSmp, 'envelopeSmp'),
    };
    body.signature = this.signMutation('state.change-key', o, body);
    return this.call<ChangeKeyResult>('POST', '/api/sync/change-key', body);
  }

  async recover(o: RecoverOpts): Promise<RecoverResult> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.expectedStateVersion, 'expectedStateVersion');
    assertBase64UrlNoPad(o.mutationId, 16, 'mutationId');
    assertBase64UrlNoPad(o.recoverSignPub, 32, 'recoverSignPub');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      expectedStateVersion: o.expectedStateVersion,
      smpKdf: validateSmpKdf(o.smpKdf),
      envelopeSmp: validateEnvelope(o.envelopeSmp, 'envelopeSmp'),
      recoveryKdf: validateRecoveryKdf(o.recoveryKdf),
      envelopeRecovery: validateEnvelope(o.envelopeRecovery, 'envelopeRecovery'),
      recoverSignPub: o.recoverSignPub,
    };
    body.signature = this.signMutation('state.recover', o, body);
    return this.call<RecoverResult>('POST', '/api/sync/recover', body);
  }

  async destroy(o: DestroyOpts): Promise<DestroyResult> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.expectedStateVersion, 'expectedStateVersion');
    assertBase64UrlNoPad(o.mutationId, 16, 'mutationId');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      expectedStateVersion: o.expectedStateVersion,
      newState: validateNewState(o.newState),
    };
    body.signature = this.signMutation('state.destroy', o, body);
    return this.call<DestroyResult>('POST', '/api/sync/destroy', body);
  }

  private signMutation(action: SyncAction, o: { userId: string; keyEpoch: string; mutationId: string; seed: Uint8Array }, body: Record<string, unknown>): string {
    const requestDigest = requestDigestOf(body);
    const common = { userId: o.userId, keyEpoch: o.keyEpoch, mutationId: o.mutationId, requestDigest };
    const input = action === 'record.put' || action === 'record.delete'
      ? buildRecordSigningInput(action, { ...common, recordId: body.recordId as string, baseVersion: body.baseVersion as string })
      : buildStateSigningInput(action, { ...common, expectedStateVersion: body.expectedStateVersion as string });
    return signSigningInput(input, o.seed);
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown, opts?: { retry?: boolean }): Promise<T> {
    const res = await this.http.requestRaw(method, path, body, opts);
    if (res.status >= 200 && res.status < 300) return res.body as T;
    const b = (res.body ?? {}) as { code?: string; message?: string; currentVersion?: string; currentKeyEpoch?: string };
    throw new SyncApiError(res.status, b.code, b.currentVersion, b.currentKeyEpoch, b.message);
  }
}
