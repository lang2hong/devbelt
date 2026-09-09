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
import { SYNC_DOMAIN, assertU64, assertEpoch, verifySignature, checkReceipt, recordReceipt, assertEnvelopeFreshness } from './syncShared.js';

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
  envelopeSmp: EnvelopeDto;
  envelopeRecovery: EnvelopeDto;
  recoveryCodeSetTime: string | null;
}

/** 出站 envelope DTO：与客户端 EnvelopeDto 对称（长名 + 每 envelope 协议字段）。 */
export interface EnvelopeDto {
  protocolVersion: number;
  cipherSuite: string;
  formatVersion: number;
  envelopeVersion: string;
  nonce: string;
  ciphertext: string;
  tag: string;
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
      // 验签必须先于 receipt 查询：否则只持会话 token（无同步签名私钥）者就能用
      // 任意 mutationId/digest 探测 receipt —— 未命中/异 digest/命中三种结果可区分，
      // 且命中时会返回 stateVersion。前置验签后，未签名请求一律止步于此。
      this.assertSignature(state.signPub, userId, input, 'state.change-key');

      const receipt = await checkReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest);
      if (receipt) return { keyEpoch: input.keyEpoch, stateVersion: receipt.resultVersion ?? state.stateVersion };

      this.assertExpectedVersion(state, input.expectedStateVersion);

      validateSmpKdf(input.smpKdf);
      // envelope 版本单调：smp +1；recovery 不变（§7.3）。
      if (input.envelopeSmp.version !== incU64(state.envelopeSmp.version)) throw new ValidationError('smp envelope version must be increment of stored');
      if (input.envelopeSmp.nonce.length !== 12 || input.envelopeSmp.ct.length !== 32 || input.envelopeSmp.tag.length !== 16) throw new ValidationError('invalid smp envelope');
      // 防 AES-GCM 密钥流复用：salt 与 nonce 都必须换新（详见 assertEnvelopeFreshness）。
      assertEnvelopeFreshness(
        { salt: state.smpKdf.salt, nonce: state.envelopeSmp.nonce },
        { salt: input.smpKdf.salt, nonce: input.envelopeSmp.nonce },
        'smp',
      );

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

  async recover(userId: number, input: RecoverInput): Promise<{ keyEpoch: string; stateVersion: string; recoveryCodeSetTime: string | null }> {
    assertU64(input.keyEpoch, 'keyEpoch');
    assertU64(input.expectedStateVersion, 'expectedStateVersion');
    assertU64(input.envelopeSmp.version, 'envelopeSmp.version');
    assertU64(input.envelopeRecovery.version, 'envelopeRecovery.version');
    return this.runner(async (tx) => {
      const state = await this.lockActive(tx, userId);
      assertEpoch(state, input.keyEpoch);
      // recover 用旧 recoverSignPub 验签（§7.4）。前置于 receipt 查询，理由同 change-key。
      this.assertSignature(state.recoverSignPub, userId, input, 'state.recover');

      const receipt = await checkReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest);
      if (receipt) return { keyEpoch: input.keyEpoch, stateVersion: receipt.resultVersion ?? state.stateVersion, recoveryCodeSetTime: state.recoveryCodeSetTime ? state.recoveryCodeSetTime.toISOString() : null };

      this.assertExpectedVersion(state, input.expectedStateVersion);

      validateSmpKdf(input.smpKdf);
      validateRecoveryKdf(input.recoveryKdf);
      if (input.envelopeSmp.version !== incU64(state.envelopeSmp.version)) throw new ValidationError('smp envelope version must be increment of stored');
      if (input.envelopeRecovery.version !== incU64(state.envelopeRecovery.version)) throw new ValidationError('recovery envelope version must be increment of stored');
      if (input.recoverSignPub.length !== 32) throw new ValidationError('invalid recoverSignPub length');
      // 两条 envelope 都被重写，各自独立校验新鲜度。
      assertEnvelopeFreshness(
        { salt: state.smpKdf.salt, nonce: state.envelopeSmp.nonce },
        { salt: input.smpKdf.salt, nonce: input.envelopeSmp.nonce },
        'smp',
      );
      assertEnvelopeFreshness(
        { salt: state.recoveryKdf.salt, nonce: state.envelopeRecovery.nonce },
        { salt: input.recoveryKdf.salt, nonce: input.envelopeRecovery.nonce },
        'recovery',
      );

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

  async destroy(userId: number, input: DestroyInput): Promise<{ keyEpoch: string; stateVersion: string; changeSequence: string }> {
    validateNewState(input.newState);
    assertU64(input.keyEpoch, 'keyEpoch');
    assertU64(input.expectedStateVersion, 'expectedStateVersion');
    return this.runner(async (tx) => {
      const state = await this.lockActive(tx, userId);

      // 这里刻意**不**把验签前置（其它 mutation 都前置了），因为 destroy 会用
      // newState.signPub 替换 signPub：重放时 state 里已是新公钥，拿它验旧签名
      // 必然失败，前置验签会把合法重放变成 401。
      //
      // 不前置是否形成 receipt 预言机？不构成：checkReceipt 命中要求
      // requestDigest 与已存的 32 字节 SHA-256 **逐字节相等**，攻击者无法凭
      // 会话 token 猜出它；猜错只会得到与「不存在」同形的 undefined 或
      // 「同 id 异 digest」的 409，都不泄露额外信息。真正需要前置验签的是
      // change-key / recover —— 它们不换 signPub，前置无副作用。
      const receipt = await checkReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest);
      if (receipt) {
        // 重放应返回**当次 mutation 的结果**，而非 read-time 的当前状态：
        // destroy → change-key → 重放 destroy 时，后者会把 change-key 的版本号
        // 当成 destroy 的结果报回去，违反幂等契约。receipt 里存了原始结果。
        return {
          keyEpoch: state.keyEpoch,
          stateVersion: receipt.resultVersion ?? state.stateVersion,
          changeSequence: receipt.resultChangeSequence ?? state.changeSequence,
        };
      }
      assertEpoch(state, input.keyEpoch);
      this.assertSignature(state.signPub, userId, input, 'state.destroy');
      this.assertExpectedVersion(state, input.expectedStateVersion);

      // destroy 用 newState 整体替换两条 envelope。validateNewState 只校验长度，
      // 不比对旧值，故此处仍需新鲜度校验：否则「销毁后用同 salt+nonce 重建」
      // 会与销毁前的 envelope 构成密钥流复用。
      assertEnvelopeFreshness(
        { salt: state.smpKdf.salt, nonce: state.envelopeSmp.nonce },
        { salt: input.newState.smpKdf.salt, nonce: input.newState.envelopeSmp.nonce },
        'smp',
      );
      assertEnvelopeFreshness(
        { salt: state.recoveryKdf.salt, nonce: state.envelopeRecovery.nonce },
        { salt: input.newState.recoveryKdf.salt, nonce: input.newState.envelopeRecovery.nonce },
        'recovery',
      );

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

      await recordReceipt(tx, this.mutationRepo, userId, input.keyEpoch, input.mutationId, input.requestDigest, 'state.destroy', next.stateVersion, next.changeSequence);
      return { keyEpoch: next.keyEpoch, stateVersion: next.stateVersion, changeSequence: next.changeSequence };
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

export function toDto(s: Omit<PersonalSyncState, 'createTime' | 'updateTime'>): StateDto {
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
    envelopeSmp: toEnvelopeDto(s.envelopeSmp),
    envelopeRecovery: toEnvelopeDto(s.envelopeRecovery),
    recoveryCodeSetTime: s.recoveryCodeSetTime ? s.recoveryCodeSetTime.toISOString() : null,
  };
}

/** envelope 出站序列化：长名 + 每 envelope 附带协议字段（对齐客户端 EnvelopeDto）。 */
function toEnvelopeDto(e: SyncEnvelope): EnvelopeDto {
  return {
    protocolVersion: 1,
    cipherSuite: 'AES-256-GCM',
    formatVersion: 1,
    envelopeVersion: e.version,
    nonce: e.nonce.toString('base64url'),
    ciphertext: e.ct.toString('base64url'),
    tag: e.tag.toString('base64url'),
  };
}
