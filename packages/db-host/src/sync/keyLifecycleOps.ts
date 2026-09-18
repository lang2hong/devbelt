import { encodeBase64Url, decodeBase64Url } from './crypto/recoveryCode.js';
import { deriveSyncSignKeyPair } from './crypto/keyStore.js';
import {
  createInitialMaterial,
  newRecoveryCode,
  unlockDek,
  buildChangeKeyMaterial,
  buildRecoverMaterial,
  buildRecoverByAccountMaterial,
  newStateFromMaterial,
  type InitialSyncMaterial,
  type RecoverMaterial,
  type RecoverByAccountMaterial,
} from './keyLifecycle.js';
import { hkdfSha256, SYNC_INFO } from './crypto/hkdf.js';
import { openEnvelope } from './envelope.js';
import { SyncApiError, type PersonalSyncClient } from './e2e/client.js';
import { assertU64Decimal, type StateDto } from './e2e/types.js';
import type { StateStore, SyncStateSnapshot } from './e2e/stateStore.js';
import { randomBytes } from 'crypto';

export interface KeyLifecycleDeps {
  userId: string;
  client: PersonalSyncClient;
  stateStore: StateStore;
  isUnlocked: () => boolean;
  /** 内存 DEK / signSeed / keyEpoch 取值器（未解锁时分别为 undefined）。 */
  dek: () => Uint8Array | undefined;
  keyEpoch: () => string | undefined;
  signSeed: () => Uint8Array | undefined;
  pendingCleanup: () => { fromKeyEpoch: string; toKeyEpoch: string } | undefined;
  getRemoteState: () => Promise<StateDto>;
  unlockFromState: (state: StateDto, dek: Uint8Array) => Promise<void>;
  installNewEpoch: (fromKeyEpoch: string | undefined, snapshot: SyncStateSnapshot, dek: Uint8Array) => Promise<void>;
  /** 在不可逆远端请求前落 durable epoch-cleanup intent。 */
  writePendingIntent: (intent: { fromKeyEpoch: string; toKeyEpoch: string }) => Promise<void>;
}

/** 恒定时间字节比较（密钥/DEK 比对用）。 */
function byteEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a[i] ^ b[i];
  return d === 0;
}

/**
 * 密钥生命周期编排（自 PersonalSyncSession 抽出，逐字搬移）。
 *
 * 改口令 / 恢复码恢复 / 账号恢复 / 销毁 / 重置 / 挑战请求。对会话内部状态（内存 DEK、
 * epoch、snapshot、解锁与落新 epoch）的访问全部经 `KeyLifecycleDeps` 端口回注，
 * 本模块不直接持有会话字段。
 */
export class KeyLifecycleOps {
  constructor(private readonly deps: KeyLifecycleDeps) {}

  /**
   * 修改同步口令（解锁态）：旧 SMP 验证 + 新 SMP 重封 smp envelope（recovery 不变，DEK 不变）。
   * 失败不改本地 snapshot/DEK。签名用当前内存 syncSign（命令层不接触私钥）。
   */
  async changeSyncPassword(oldSmp: string, newSmp: string): Promise<void> {
    const dek = this.deps.dek();
    const keyEpoch = this.deps.keyEpoch();
    const signSeed = this.deps.signSeed();
    if (!dek || !keyEpoch || !signSeed) throw new Error('sync session is locked');
    const state = await this.deps.getRemoteState();
    if (state.keyEpoch !== keyEpoch) throw new Error('sync epoch mismatch');
    const material = await buildChangeKeyMaterial(
      this.deps.userId, keyEpoch, oldSmp, state.smpKdf, state.envelopeSmp, newSmp,
    );
    try {
      if (!byteEq(material.verifiedDek, dek)) throw new Error('sync passphrase mismatch');
      const local = this.deps.stateStore.getSnapshot();
      if (!local) throw new Error('sync session has no local state');
      const res = await this.deps.client.changeKey({
        userId: this.deps.userId,
        keyEpoch,
        mutationId: this.mintMutationId(),
        seed: signSeed,
        expectedStateVersion: local.stateVersion,
        smpKdf: material.smpKdf,
        envelopeSmp: material.envelopeSmp,
      });
      const stateVersion = this.assertSameEpochReceipt(res, keyEpoch);
      await this.deps.stateStore.setSnapshot({ keyEpoch, stateVersion, changeSequence: local.changeSequence });
    } finally {
      material.verifiedDek.fill(0);
    }
  }

  /**
   * 恢复码恢复（锁定态）：旧恢复码解封 DEK + 旧 recoverSign 签名；新 SMP/新恢复码重封。
   * 成功后保存 DEK、更新 snapshot、解锁并排首次同步；返回新恢复码（一次性展示）。
   */
  async recoverSync(recoveryCode: string, newSmp: string): Promise<string> {
    if (this.deps.isUnlocked()) throw new Error('sync session already unlocked');
    const state = await this.deps.getRemoteState();
    const oldRecoveryRaw = decodeBase64Url(recoveryCode.replace(/\s+/g, ''));
    const newRecovery = newRecoveryCode();
    let material: RecoverMaterial | undefined;
    try {
      material = await buildRecoverMaterial(
        this.deps.userId, state.keyEpoch, oldRecoveryRaw, state.recoveryKdf, state.envelopeRecovery,
        state.envelopeSmp.envelopeVersion, newSmp, newRecovery.raw,
      );
      await this.deps.client.recover({
        userId: this.deps.userId,
        keyEpoch: state.keyEpoch,
        mutationId: this.mintMutationId(),
        seed: material.oldRecoverSignSeed,
        expectedStateVersion: state.stateVersion,
        smpKdf: material.smpKdf,
        envelopeSmp: material.envelopeSmp,
        recoveryKdf: material.recoveryKdf,
        envelopeRecovery: material.envelopeRecovery,
        recoverSignPub: material.recoverSignPub,
      });
      const newState = await this.deps.getRemoteState();
      // 复用 unlockFromState 的 signPub 一致性校验 + 完整解锁语义（验证恢复出的 DEK 确属该 state）。
      await this.deps.unlockFromState(newState, material.dek);
      return newRecovery.code;
    } finally {
      oldRecoveryRaw.fill(0);
      newRecovery.raw.fill(0);
      material?.dek.fill(0);
      material?.oldRecoverSignSeed.fill(0);
    }
  }

  /**
   * 账号恢复（锁定态）：先以账户登录口令自证（服务端 step-up 复核），服务端下发
   * accountRecoveryKey + envelopeAccount → 解 DEK → 用 DEK 派生 syncSign 从新重设
   * 口令/恢复码/账号钥匙，数据不丢。返回新恢复码。
   */
  async recoverByAccount(accountPassword: string, newSmp: string): Promise<string> {
    if (this.deps.isUnlocked()) throw new Error('sync session already unlocked');
    const state = await this.deps.getRemoteState();
    const accountMaterial = await this.deps.client.recoverViaAccount(accountPassword);
    const oldAccountKey = decodeBase64Url(accountMaterial.accountRecoveryKey);
    const kekAccount = hkdfSha256(oldAccountKey, new Uint8Array(0), SYNC_INFO.kekAccount);
    let dek: Uint8Array;
    try {
      dek = openEnvelope(kekAccount, accountMaterial.envelopeAccount, this.deps.userId, state.keyEpoch, 'account');
    } finally {
      kekAccount.fill(0);
      oldAccountKey.fill(0);
    }
    // 恢复出的 DEK 必须确属该 state（signPub 一致性），否则拒绝。
    if (encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) !== state.signPub) {
      dek.fill(0);
      throw new Error('account recovery key does not match sync state');
    }

    const newRecovery = newRecoveryCode();
    const newAccountRaw = new Uint8Array(randomBytes(32));
    let material: RecoverByAccountMaterial | undefined;
    try {
      material = await buildRecoverByAccountMaterial(
        this.deps.userId,
        state.keyEpoch,
        dek,
        state.envelopeSmp.envelopeVersion,
        state.envelopeRecovery.envelopeVersion,
        accountMaterial.envelopeAccount.envelopeVersion,
        newSmp,
        newRecovery.raw,
        newAccountRaw,
      );
      await this.deps.client.accountRecover({
        userId: this.deps.userId,
        keyEpoch: state.keyEpoch,
        mutationId: this.mintMutationId(),
        seed: material.signSeed,
        expectedStateVersion: state.stateVersion,
        smpKdf: material.smpKdf,
        envelopeSmp: material.envelopeSmp,
        recoveryKdf: material.recoveryKdf,
        envelopeRecovery: material.envelopeRecovery,
        envelopeAccount: material.envelopeAccount,
        accountRecoveryKey: encodeBase64Url(newAccountRaw),
        recoverSignPub: material.recoverSignPub,
      });
      const newState = await this.deps.getRemoteState();
      await this.deps.unlockFromState(newState, dek);
      return newRecovery.code;
    } finally {
      dek.fill(0);
      newRecovery.raw.fill(0);
      newAccountRaw.fill(0);
      material?.signSeed.fill(0);
    }
  }

  /**
   * 销毁同步数据（解锁态）：当前 SMP 验证 + 全新 epoch 材料，走 epoch transition 幂等收敛。
   * 返回新恢复码（一次性展示）；旧 epoch DEK/store 被清理。
   */
  async destroySync(smp: string): Promise<string> {
    const dek = this.deps.dek();
    const keyEpoch = this.deps.keyEpoch();
    const signSeed = this.deps.signSeed();
    if (!dek || !keyEpoch || !signSeed) throw new Error('sync session is locked');
    const state = await this.deps.getRemoteState();
    if (state.keyEpoch !== keyEpoch) throw new Error('sync epoch mismatch');
    const verified = await unlockDek(this.deps.userId, keyEpoch, smp, state.smpKdf, state.envelopeSmp);
    try {
      if (!byteEq(verified, dek)) throw new Error('sync passphrase mismatch');
    } finally {
      verified.fill(0);
    }

    const fromKeyEpoch = keyEpoch;
    const newKeyEpoch = String(BigInt(fromKeyEpoch) + 1n);
    const newRecovery = newRecoveryCode();
    let material: InitialSyncMaterial | undefined;
    try {
      material = await createInitialMaterial(this.deps.userId, newKeyEpoch, smp, newRecovery.raw);
      const local = this.deps.stateStore.getSnapshot();
      if (!local) throw new Error('sync session has no local state');
      // 不可逆请求前先落 durable transition intent：即使回执丢失/响应中断，重启后可据远端 state
      // 判定提交结果（toKeyEpoch 命中 → 清理；fromKeyEpoch 命中 → 撤销）收敛旧 epoch。
      await this.deps.writePendingIntent({ fromKeyEpoch, toKeyEpoch: newKeyEpoch });
      const res = await this.deps.client.destroy({
        userId: this.deps.userId,
        keyEpoch: fromKeyEpoch,
        mutationId: this.mintMutationId(),
        seed: signSeed,
        expectedStateVersion: local.stateVersion,
        newState: newStateFromMaterial(material),
      });
      const ownedDek = material.dek.slice();
      const newSnapshot = this.assertEpochAdvanceReceipt(res, newKeyEpoch);
      try {
        await this.deps.installNewEpoch(fromKeyEpoch, newSnapshot, ownedDek);
      } catch (err) {
        // installNewEpoch 成功时 ownedDek 成为 live DEK（不零化）；失败路径兜底清零，
        // 不依赖其内部实现是否清零，避免抛错时这份拷贝泄漏。
        ownedDek.fill(0);
        throw err;
      }
      return newRecovery.code;
    } finally {
      newRecovery.raw.fill(0);
      material?.dek.fill(0);
      material?.accountRecoveryKey.fill(0);
    }
  }

  /** 请求丢失 SMP 重置的邮件挑战（锁定态；服务端限流 + 防枚举恒同响应）。 */
  async requestResetChallenge(): Promise<void> {
    await this.deps.client.resetChallenges();
  }

  /**
   * 丢失 SMP 重置（锁定态）：凭浏览器交接的一次性 handoff ticket + 新 SMP。
   * 旧数据不可恢复。若本地有旧 epoch 则走 transition 清理；否则直接落新 epoch。
   * 服务端返回完整 StateDto；本方法只取三字段快照（新 DEK 在本地由新材料派生）。
   * 返回新恢复码。
   */
  async resetSyncAfterLoss(handoffTicket: string, newSmp: string): Promise<string> {
    if (this.deps.isUnlocked()) throw new Error('sync session already unlocked; use destroy instead');
    // 已有未收敛的 epoch-cleanup journal 时拒绝 reset：否则会用新 intent 覆盖旧的单键 journal，
    // 使更旧 epoch 的本地状态（recordMap/outbox/unresolved/DEK）失去清理入口而永久残留。
    if (this.deps.pendingCleanup()) {
      throw new Error('pending sync cleanup in progress; unlock to finish it before resetting');
    }
    let newKeyEpoch: string;
    try {
      const remote = await this.deps.getRemoteState();
      newKeyEpoch = String(BigInt(remote.keyEpoch) + 1n);
    } catch (err) {
      if (err instanceof SyncApiError && err.status === 400 && err.code === 'SYNC_NOT_INITIALIZED') {
        newKeyEpoch = '1';
      } else {
        throw err;
      }
    }
    const localEpoch = this.deps.stateStore.getSnapshot()?.keyEpoch;
    const hasLocalEpoch = localEpoch !== undefined && BigInt(localEpoch) < BigInt(newKeyEpoch);
    const newRecovery = newRecoveryCode();
    let material: InitialSyncMaterial | undefined;
    try {
      material = await createInitialMaterial(this.deps.userId, newKeyEpoch, newSmp, newRecovery.raw);
      // 本地下有旧 epoch 时才须清理；请求前先落 durable intent 覆盖「远端已提交、ticket 已消费、
      // 回执丢失」的未知结果窗口（同 ticket 同 newState 重试仅 3 次，且 ticket 单次消费）。
      if (hasLocalEpoch) await this.deps.writePendingIntent({ fromKeyEpoch: localEpoch as string, toKeyEpoch: newKeyEpoch });
      const res = await this.deps.client.resetAfterLossWithHandoff(handoffTicket, newStateFromMaterial(material));
      const ownedDek = material.dek.slice();
      const newSnapshot = this.assertEpochAdvanceReceipt(res, newKeyEpoch);
      const fromKeyEpoch = hasLocalEpoch ? (localEpoch as string) : undefined;
      try {
        await this.deps.installNewEpoch(fromKeyEpoch, newSnapshot, ownedDek);
      } catch (err) {
        ownedDek.fill(0);
        throw err;
      }
      return newRecovery.code;
    } finally {
      newRecovery.raw.fill(0);
      material?.dek.fill(0);
      material?.accountRecoveryKey.fill(0);
    }
  }

  private mintMutationId(): string {
    return encodeBase64Url(new Uint8Array(randomBytes(16)));
  }

  /** 校验「同 epoch 状态变更」回执（change-key），返回新的 stateVersion。 */
  private assertSameEpochReceipt(res: unknown, expectedKeyEpoch: string): string {
    if (typeof res !== 'object' || res === null) throw new Error('malformed sync receipt');
    const o = res as Record<string, unknown>;
    if (typeof o.keyEpoch !== 'string' || typeof o.stateVersion !== 'string') throw new Error('malformed sync receipt');
    assertU64Decimal(o.keyEpoch, 'receipt.keyEpoch');
    assertU64Decimal(o.stateVersion, 'receipt.stateVersion');
    if (o.keyEpoch !== expectedKeyEpoch) throw new Error('sync receipt epoch mismatch');
    return o.stateVersion;
  }

  /** 校验「epoch 前进」回执（destroy/reset），返回三字段快照；epoch 必须等于预期 next。 */
  private assertEpochAdvanceReceipt(res: unknown, expectedKeyEpoch: string): SyncStateSnapshot {
    if (typeof res !== 'object' || res === null) throw new Error('malformed sync receipt');
    const o = res as Record<string, unknown>;
    if (typeof o.keyEpoch !== 'string' || typeof o.stateVersion !== 'string' || typeof o.changeSequence !== 'string') {
      throw new Error('malformed sync receipt');
    }
    assertU64Decimal(o.keyEpoch, 'receipt.keyEpoch');
    assertU64Decimal(o.stateVersion, 'receipt.stateVersion', true);
    assertU64Decimal(o.changeSequence, 'receipt.changeSequence', true);
    if (o.keyEpoch !== expectedKeyEpoch) throw new Error('sync receipt epoch mismatch');
    return { keyEpoch: o.keyEpoch, stateVersion: o.stateVersion, changeSequence: o.changeSequence };
  }
}