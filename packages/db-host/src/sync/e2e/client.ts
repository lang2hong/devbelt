import type { SyncClient } from '../syncClient.js';
import { requestDigestOf } from '../crypto/digest.js';
import { buildRecordSigningInput, buildStateSigningInput, signSigningInput, type SyncAction } from '../crypto/sign.js';
import {
  assertBase64UrlNoPad,
  assertBase64UrlRange,
  assertRecordId,
  assertU64Decimal,
  validateAccountRecoveryMaterial,
  validateEnvelope,
  validateNewState,
  validateRecoveryKdf,
  validateSmpKdf,
  type AccountRecoveryMaterialDto,
  type EnvelopeDto,
  type NewStateDto,
  type RecoveryKdfDto,
  type SmpKdfDto,
  type StateDto,
} from './types.js';

/**
 * 个人同步协议客户端（10 个路由，5 个需签名）。
 *
 * 复用 `SyncClient.requestRaw` 的鉴权和 401 单飞刷新能力。本层只提供协议方法与
 * 签名/摘要原语，不持有本地 epoch/nonce/状态机，也不管理签名 seed 生命周期。
 *
 * requestDigest 顺序锚点：从「实际发送 body（尚未附 signature）」构造纯 JSON
 * 冻结对象 → 算 digest → 构造 signingInput（含 digest）→ 签名 → 附 signature。
 *
 * 重试策略：默认自动重试网络/5xx ≤3（GET state/records、5 个签名 mutation 由 receipt
 * 幂等）；init 禁止重试（无 receipt，重放误报成功为失败）。reset-after-loss 旧 reset-token
 * 协议无 receipt 故禁止重试；新 handoff 协议有 completed receipt（同票同摘要重放），
 * 故允许默认重试（见 resetAfterLossWithHandoff）。
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

export interface RecoverByAccountOpts extends MutateOptsBase {
  expectedStateVersion: string;
  smpKdf: SmpKdfDto;
  envelopeSmp: EnvelopeDto;
  recoveryKdf: RecoveryKdfDto;
  envelopeRecovery: EnvelopeDto;
  envelopeAccount: EnvelopeDto;
  accountRecoveryKey: string;
  recoverSignPub: string;
}

/** recover-via-account 下发的账号恢复材料（= 校验器返回的 DTO，避免重复定义）。 */
export type AccountRecoveryMaterial = AccountRecoveryMaterialDto;

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
    return this.call<StateDto>('GET', '/api/db/sync/state');
  }

  async init(newState: NewStateDto): Promise<void> {
    return this.call<void>('PUT', '/api/db/sync/init', { newState: validateNewState(newState) }, { retry: false });
  }

  async getRecords(after: string, snapshotSequence: string | undefined, limit: number): Promise<unknown> {
    assertU64Decimal(after, 'after', true);
    if (snapshotSequence !== undefined) assertU64Decimal(snapshotSequence, 'snapshotSequence');
    const q = new URLSearchParams();
    if (after !== '0') q.set('after', after);
    if (snapshotSequence !== undefined) q.set('snapshotSequence', snapshotSequence);
    q.set('limit', String(limit));
    return this.call('GET', `/api/db/sync/records?${q.toString()}`);
  }

  resetChallenges(): Promise<unknown> {
    return this.call('POST', '/api/db/sync/reset-challenges');
  }

  /**
   * sync-reset 最终交接（P3 切片 5）：扩展凭一次性 handoffTicket 提交 newState。
   * 与旧 resetAfterLoss(resetToken) 不同，本端点有 completed receipt —— 同 ticket + 同
   * newState 的响应丢失/重叠重试会重放首次完整 StateDto。故用默认重试（网络/5xx ≤3）。
   */
  async resetAfterLossWithHandoff(handoffTicket: string, newState: NewStateDto): Promise<StateDto> {
    assertBase64UrlNoPad(handoffTicket, 32, 'handoffTicket');
    return this.call<StateDto>('POST', '/api/db/sync/reset-after-loss', {
      handoffTicket,
      newState: validateNewState(newState),
    });
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
    return this.call<RecordReceipt>('PUT', `/api/db/sync/records/${encodeURIComponent(o.recordId)}`, body);
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
    return this.call<RecordReceipt>('DELETE', `/api/db/sync/records/${encodeURIComponent(o.recordId)}`, body);
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
    return this.call<RecordReceipt>('PUT', `/api/db/sync/records/${encodeURIComponent(o.recordId)}`, body);
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
    return this.call<RecordReceipt>('DELETE', `/api/db/sync/records/${encodeURIComponent(o.recordId)}`, body);
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
    return this.call<ChangeKeyResult>('POST', '/api/db/sync/change-key', body);
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
    return this.call<RecoverResult>('POST', '/api/db/sync/recover', body);
  }

  /** 服务端下发的账号恢复材料在返回前经严格校验（fail-closed），不直接信任网络 DTO。 */
  async recoverViaAccount(accountPassword: string): Promise<AccountRecoveryMaterial> {
    // 该端点按用户限流（step-up 配额 5/小时）且无回执幂等，禁止自动重试，避免一次
    // 模糊网络失败被重试多次、耗尽配额把账号锁定一小时。
    const raw = await this.call<unknown>('POST', '/api/db/sync/recover-via-account', { password: accountPassword }, { retry: false });
    return validateAccountRecoveryMaterial(raw);
  }

  async accountRecover(o: RecoverByAccountOpts): Promise<RecoverResult> {
    assertU64Decimal(o.keyEpoch, 'keyEpoch');
    assertU64Decimal(o.expectedStateVersion, 'expectedStateVersion');
    assertBase64UrlNoPad(o.mutationId, 16, 'mutationId');
    assertBase64UrlNoPad(o.recoverSignPub, 32, 'recoverSignPub');
    assertBase64UrlNoPad(o.accountRecoveryKey, 32, 'accountRecoveryKey');
    const body: Record<string, unknown> = {
      protocolVersion: 1,
      keyEpoch: o.keyEpoch,
      mutationId: o.mutationId,
      expectedStateVersion: o.expectedStateVersion,
      smpKdf: validateSmpKdf(o.smpKdf),
      envelopeSmp: validateEnvelope(o.envelopeSmp, 'envelopeSmp'),
      recoveryKdf: validateRecoveryKdf(o.recoveryKdf),
      envelopeRecovery: validateEnvelope(o.envelopeRecovery, 'envelopeRecovery'),
      envelopeAccount: validateEnvelope(o.envelopeAccount, 'envelopeAccount'),
      accountRecoveryKey: o.accountRecoveryKey,
      recoverSignPub: o.recoverSignPub,
    };
    body.signature = this.signMutation('state.recover-by-account', o, body);
    // account-recover 有 mutation receipt 幂等，且服务端回执优先于 sync:keys 限流（见 syncStateService），
    // 响应丢失时自动重试会命中回执并返回首次结果，不再误报失败、也不丢恢复码。
    return this.call<RecoverResult>('POST', '/api/db/sync/account-recover', body);
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
    return this.call<DestroyResult>('POST', '/api/db/sync/destroy', body);
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
    const res = await this.http.requestRaw(method, path, body, { retry: opts?.retry });
    if (res.status >= 200 && res.status < 300) return res.body as T;
    const b = (res.body ?? {}) as { code?: string; message?: string; currentVersion?: string; currentKeyEpoch?: string };
    throw new SyncApiError(res.status, b.code, b.currentVersion, b.currentKeyEpoch, b.message);
  }
}
