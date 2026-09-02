import type { TxRunner, Queryable } from '../repository/mysql/db.js';
import type {
  ISyncStateRepo,
  ISyncRecordRepo,
  ISyncMutationRepo,
} from '../repository/interfaces.js';
import type { PersonalSyncState, SmpKdf, RecoveryKdf, SyncEnvelope } from '../domain/entities.js';
import {
  SyncNotInitializedError,
  SyncStateExistsError,
  SyncVersionConflictError,
  SyncProtocolUnsupportedError,
  ValidationError,
} from '../domain/errors.js';
import { incU64 } from '../domain/syncU64.js';
import { SYNC_DOMAIN, assertU64, assertEpoch, verifySignature, checkReceipt, recordReceipt } from './syncShared.js';

const SUPPORTED_VERSION = 1 as const;
const SUITE = 'AES-256-GCM' as const;

/** init / destroy / reset 里由客户端提交的新状态（epoch/stateVersion/changeSequence 由服务端定）。 */
export interface SyncNewState {
  protocolVersion: 1;
  cipherSuite: 'AES-256-GCM';
  formatVersion: 1;
  smpKdf: SmpKdf;
  recoveryKdf: RecoveryKdf;
  envelopeSmp: SyncEnvelope;
  envelopeRecovery: SyncEnvelope;
  signPub: Buffer;
  recoverSignPub: Buffer;
}

interface SignedStateMutation {
  keyEpoch: string;
  mutationId: string;       // Base64Url22
  signature: Buffer;        // 64B
  expectedStateVersion: string;
  requestDigest: string;    // Base64Url43
}

export type ChangeKeyInput = SignedStateMutation & { smpKdf: SmpKdf; envelopeSmp: SyncEnvelope };
export type RecoverInput = SignedStateMutation & {
  smpKdf: SmpKdf; envelopeSmp: SyncEnvelope;
  recoveryKdf: RecoveryKdf; envelopeRecovery: SyncEnvelope; recoverSignPub: Buffer;
};
export type DestroyInput = SignedStateMutation & { newState: SyncNewState };

export interface StateDto {
  protocolVersion: number;
  cipherSuite: string;
  formatVersion: number;
  keyEpoch: string;
  stateVersion: string;
  changeSequence: string;
  signPub: string;
  recoverSignPub: string;
  smpKdf: Record<string, unknown>;
  recoveryKdf: Record<string, unknown>;
  envelopeSmp: { version: string; nonce: string; ct: string; tag: string };
  envelopeRecovery: { version: string; nonce: string; ct: string; tag: string };
  recoveryCodeSetTime: string | null;
}

function validateV1Protocol(protocolVersion: number, cipherSuite: string, formatVersion: number): void {
  if (protocolVersion !== SUPPORTED_VERSION || formatVersion !== SUPPORTED_VERSION || cipherSuite !== SUITE) {
    throw new SyncProtocolUnsupportedError();
  }
}

function validateSmpKdf(k: SmpKdf): void {
  if (k.alg !== 'argon2id' || k.outputBytes !== 32) throw new SyncProtocolUnsupportedError('SMP KDF must be argon2id/32B');
  if (k.memoryKiB < 65536 || k.memoryKiB > 262144) throw new ValidationError('argon2id memoryKiB out of range');
  if (k.iterations < 3 || k.iterations > 10) throw new ValidationError('argon2id iterations out of range');
  if (k.parallelism < 1 || k.parallelism > 4) throw new ValidationError('argon2id parallelism out of range');
  if (k.salt.length !== 16) throw new ValidationError('argon2id salt must be 16 bytes');
}

function validateRecoveryKdf(k: RecoveryKdf): void {
  if (k.alg !== 'hkdf-sha256' || k.outputBytes !== 32) throw new SyncProtocolUnsupportedError('recovery KDF must be hkdf-sha256/32B');
  if (k.salt.length !== 16) throw new ValidationError('hkdf salt must be 16 bytes');
}

export function validateNewState(n: SyncNewState): void {
  validateV1Protocol(n.protocolVersion, n.cipherSuite, n.formatVersion);
  validateSmpKdf(n.smpKdf);
  validateRecoveryKdf(n.recoveryKdf);
  if (n.envelopeSmp.version !== '1' || n.envelopeRecovery.version !== '1') {
    throw new ValidationError('new-state envelopes must start at version 1');
  }
  if (n.envelopeSmp.nonce.length !== 12 || n.envelopeSmp.ct.length !== 32 || n.envelopeSmp.tag.length !== 16) throw new ValidationError('invalid smp envelope');
  if (n.envelopeRecovery.nonce.length !== 12 || n.envelopeRecovery.ct.length !== 32 || n.envelopeRecovery.tag.length !== 16) throw new ValidationError('invalid recovery envelope');
  if (n.signPub.length !== 32 || n.recoverSignPub.length !== 32) throw new ValidationError('invalid sync public key length');
}

export function toState(userId: number, keyEpoch: string, stateVersion: string, changeSequence: string, n: SyncNewState, recoveryCodeSetTime: Date): Omit<PersonalSyncState, 'createTime' | 'updateTime'> {
  return {
    userId, keyEpoch, stateVersion, changeSequence,
    protocolVersion: n.protocolVersion, cipherSuite: n.cipherSuite, formatVersion: n.formatVersion,
    smpKdf: n.smpKdf, recoveryKdf: n.recoveryKdf,
    envelopeSmp: n.envelopeSmp, envelopeRecovery: n.envelopeRecovery,
    signPub: n.signPub, recoverSignPub: n.recoverSignPub, recoveryCodeSetTime,
  };
}

export class SyncStateService {
  constructor(
    private readonly stateRepo: ISyncStateRepo,
    private readonly recordRepo: ISyncRecordRepo,
    private readonly mutationRepo: ISyncMutationRepo,
    private readonly runner: TxRunner,
  ) {}

  async getState(userId: number): Promise<StateDto> {
    const state = await this.stateRepo.findByUserId(userId);
    if (!state) throw new SyncNotInitializedError();
    return toDto(state);
  }

  async init(userId: number, newState: SyncNewState): Promise<void> {
    validateNewState(newState);
    await this.runner(async (tx) => {
      const created = await this.stateRepo.create(tx, toState(userId, '1', '1', '0', newState, new Date()));
      if (!created) throw new SyncStateExistsError();
    });
  }

  async changeKey(userId: number, input: ChangeKeyInput): Promise<{ keyEpoch: string; stateVersion: string }> {
    assertU64(input.keyEpoch, 'keyEpoch');
    assertU64(input.expectedStateVersion, 'expectedStateVersion');
    assertU64(input.envelopeSmp.version, 'envelopeSmp.version');
    return this.runner(async (tx) => {
      const state = await this.lockActive(tx, userId);
      assertEpoch(state, input.keyEpoch);
      const receipt = await checkReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest);
      if (receipt) return { keyEpoch: input.keyEpoch, stateVersion: receipt.resultVersion ?? state.stateVersion };

      this.assertSignature(state.signPub, userId, input, 'state.change-key');
      this.assertExpectedVersion(state, input.expectedStateVersion);

      validateSmpKdf(input.smpKdf);
      // envelope 版本单调：smp +1；recovery 不变（§7.3）。
      if (input.envelopeSmp.version !== incU64(state.envelopeSmp.version)) throw new ValidationError('smp envelope version must be increment of stored');
      if (input.envelopeSmp.nonce.length !== 12 || input.envelopeSmp.ct.length !== 32 || input.envelopeSmp.tag.length !== 16) throw new ValidationError('invalid smp envelope');

      const next = {
        userId,
        keyEpoch: state.keyEpoch,
        stateVersion: incU64(state.stateVersion),
        changeSequence: state.changeSequence,
        protocolVersion: state.protocolVersion,
        cipherSuite: state.cipherSuite,
        formatVersion: state.formatVersion,
        smpKdf: input.smpKdf,
        recoveryKdf: state.recoveryKdf,
        envelopeSmp: input.envelopeSmp,
        envelopeRecovery: state.envelopeRecovery,
        signPub: state.signPub,
        recoverSignPub: state.recoverSignPub,
        recoveryCodeSetTime: state.recoveryCodeSetTime,
      };
      const ok = await this.stateRepo.update(tx, userId, state.stateVersion, next);
      if (!ok) throw new SyncVersionConflictError(state.stateVersion);

      await recordReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest, 'state.change-key', next.stateVersion, null);
      return { keyEpoch: next.keyEpoch, stateVersion: next.stateVersion };
    });
  }

  async recover(userId: number, input: RecoverInput): Promise<{ keyEpoch: string; stateVersion: string; recoveryCodeSetTime: string }> {
    assertU64(input.keyEpoch, 'keyEpoch');
    assertU64(input.expectedStateVersion, 'expectedStateVersion');
    assertU64(input.envelopeSmp.version, 'envelopeSmp.version');
    assertU64(input.envelopeRecovery.version, 'envelopeRecovery.version');
    return this.runner(async (tx) => {
      const state = await this.lockActive(tx, userId);
      assertEpoch(state, input.keyEpoch);
      const receipt = await checkReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest);
      if (receipt) return { keyEpoch: input.keyEpoch, stateVersion: receipt.resultVersion ?? state.stateVersion, recoveryCodeSetTime: state.recoveryCodeSetTime ? state.recoveryCodeSetTime.toISOString() : '' };

      // recover 用旧 recoverSignPub 验签（§7.4）。
      this.assertSignature(state.recoverSignPub, userId, input, 'state.recover');
      this.assertExpectedVersion(state, input.expectedStateVersion);

      validateSmpKdf(input.smpKdf);
      validateRecoveryKdf(input.recoveryKdf);
      if (input.envelopeSmp.version !== incU64(state.envelopeSmp.version)) throw new ValidationError('smp envelope version must be increment of stored');
      if (input.envelopeRecovery.version !== incU64(state.envelopeRecovery.version)) throw new ValidationError('recovery envelope version must be increment of stored');
      if (input.recoverSignPub.length !== 32) throw new ValidationError('invalid recoverSignPub length');

      const now = new Date();
      const next = {
        userId,
        keyEpoch: state.keyEpoch,
        stateVersion: incU64(state.stateVersion),
        changeSequence: state.changeSequence,
        protocolVersion: state.protocolVersion,
        cipherSuite: state.cipherSuite,
        formatVersion: state.formatVersion,
        smpKdf: input.smpKdf,
        recoveryKdf: input.recoveryKdf,
        envelopeSmp: input.envelopeSmp,
        envelopeRecovery: input.envelopeRecovery,
        signPub: state.signPub,
        recoverSignPub: input.recoverSignPub,
        recoveryCodeSetTime: now,
      };
      const ok = await this.stateRepo.update(tx, userId, state.stateVersion, next);
      if (!ok) throw new SyncVersionConflictError(state.stateVersion);

      await recordReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest, 'state.recover', next.stateVersion, null);
      return { keyEpoch: next.keyEpoch, stateVersion: next.stateVersion, recoveryCodeSetTime: now.toISOString() };
    });
  }

  async destroy(userId: number, input: DestroyInput): Promise<{ keyEpoch: string }> {
    validateNewState(input.newState);
    assertU64(input.keyEpoch, 'keyEpoch');
    assertU64(input.expectedStateVersion, 'expectedStateVersion');
    return this.runner(async (tx) => {
      const state = await this.lockActive(tx, userId);
      assertEpoch(state, input.keyEpoch);
      const receipt = await checkReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest);
      if (receipt) return { keyEpoch: incU64(input.keyEpoch) };

      this.assertSignature(state.signPub, userId, input, 'state.destroy');
      this.assertExpectedVersion(state, input.expectedStateVersion);

      const now = new Date();
      // 逐个 tombstone：version+1 + 全局单调 change_sequence（§7.3：一个序列恰对应一条变更，永不重置）。
      let seq = state.changeSequence;
      const active = await this.recordRepo.listActiveByEpoch(tx, userId, state.keyEpoch);
      for (const r of active) {
        seq = incU64(seq);
        const ok = await this.recordRepo.softDelete(tx, userId, state.keyEpoch, r.recordId, r.version, incU64(r.version), seq, now);
        if (!ok) throw new SyncVersionConflictError(r.version);
      }

      const next = toState(userId, incU64(state.keyEpoch), '1', seq, input.newState, now);
      const ok = await this.stateRepo.update(tx, userId, state.stateVersion, next);
      if (!ok) throw new SyncVersionConflictError(state.stateVersion);

      await recordReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest, 'state.destroy', next.stateVersion, null);
      return { keyEpoch: next.keyEpoch };
    });
  }

  // ── 私有 ──

  private async lockActive(tx: Queryable, userId: number): Promise<PersonalSyncState> {
    const state = await this.stateRepo.lockByUserId(tx, userId);
    if (!state) throw new SyncNotInitializedError();
    return state;
  }

  /** receipt 幂等：同 id 同 digest → 返回已存结果；同 id 异 digest → 409；未命中或已过期 → undefined。 */
  private assertExpectedVersion(state: PersonalSyncState, expectedStateVersion: string): void {
    if (state.stateVersion !== expectedStateVersion) throw new SyncVersionConflictError(state.stateVersion);
  }

  private assertSignature(rawPub: Buffer, userId: number, input: SignedStateMutation, action: string): void {
    verifySignature(rawPub, {
      domain: SYNC_DOMAIN,
      action,
      userId: String(userId),
      keyEpoch: input.keyEpoch,
      expectedStateVersion: input.expectedStateVersion,
      mutationId: input.mutationId,
      requestDigest: input.requestDigest,
    }, input.signature);
  }
}

function toDto(s: PersonalSyncState): StateDto {
  return {
    protocolVersion: s.protocolVersion,
    cipherSuite: s.cipherSuite,
    formatVersion: s.formatVersion,
    keyEpoch: s.keyEpoch,
    stateVersion: s.stateVersion,
    changeSequence: s.changeSequence,
    signPub: s.signPub.toString('base64url'),
    recoverSignPub: s.recoverSignPub.toString('base64url'),
    smpKdf: { alg: s.smpKdf.alg, version: 1, memoryKiB: s.smpKdf.memoryKiB, iterations: s.smpKdf.iterations, parallelism: s.smpKdf.parallelism, salt: s.smpKdf.salt.toString('base64url'), outputBytes: 32 },
    recoveryKdf: { alg: s.recoveryKdf.alg, version: 1, salt: s.recoveryKdf.salt.toString('base64url'), outputBytes: 32 },
    envelopeSmp: { version: s.envelopeSmp.version, nonce: s.envelopeSmp.nonce.toString('base64url'), ct: s.envelopeSmp.ct.toString('base64url'), tag: s.envelopeSmp.tag.toString('base64url') },
    envelopeRecovery: { version: s.envelopeRecovery.version, nonce: s.envelopeRecovery.nonce.toString('base64url'), ct: s.envelopeRecovery.ct.toString('base64url'), tag: s.envelopeRecovery.tag.toString('base64url') },
    recoveryCodeSetTime: s.recoveryCodeSetTime ? s.recoveryCodeSetTime.toISOString() : null,
  };
}
