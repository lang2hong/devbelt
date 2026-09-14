import * as vscode from 'vscode';
import type { AuthService } from '../sync/authService';
import { SyncApiError } from '../sync/e2e/client';
import type { StateDto, NewStateDto } from '../sync/e2e/types';
import type { InitialSyncMaterial } from '../sync/keyLifecycle';
import { createInitialMaterial, newRecoveryCode, unlockDek } from '../sync/keyLifecycle';
import { encodeBase64Url } from '../sync/crypto/recoveryCode';
import type { SyncSessionFactory } from '../sync/sessionFactory';
import { l10n } from '../i18n';

type SyncRun = { stage: string } | undefined;

interface SyncSessionPort {
  readonly uid: string;
  readonly isUnlocked: boolean;
  readonly pendingCleanup: { fromKeyEpoch: string; toKeyEpoch: string } | undefined;
  readonly epochStale: boolean;
  readonly localEpoch: string | undefined;
  getRemoteState(): Promise<StateDto>;
  initializeSync(newState: NewStateDto, dek: Uint8Array): Promise<void>;
  unlockFromState(state: StateDto, dek: Uint8Array): Promise<void>;
  syncNow(): Promise<SyncRun>;
  lock(): void;
}

interface SyncFactoryPort {
  ensureSession(): Promise<SyncSessionPort | undefined>;
}

interface SyncUi {
  promptSmp(prompt: string): PromiseLike<string | undefined>;
  confirmRecoveryCode(code: string): PromiseLike<boolean>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  errorAction?(message: string, actionLabel: string): PromiseLike<string | undefined>;
}

export interface PersonalSyncCommandDeps {
  auth: Pick<AuthService, 'isLoggedIn' | 'refreshEntitlement'>;
  factory: SyncFactoryPort;
  ui: SyncUi;
  newRecoveryCode?: () => { code: string; raw: Uint8Array };
  createMaterial?: (userId: string, keyEpoch: string, smp: string, recoveryRaw: Uint8Array) => Promise<InitialSyncMaterial>;
  unlockDek?: (userId: string, keyEpoch: string, smp: string, state: StateDto) => Promise<Uint8Array>;
}

function newStateFrom(material: InitialSyncMaterial): NewStateDto {
  return {
    protocolVersion: 1,
    cipherSuite: 'AES-256-GCM',
    formatVersion: 1,
    smpKdf: material.smpKdf,
    recoveryKdf: material.recoveryKdf,
    envelopeSmp: material.envelopeSmp,
    envelopeRecovery: material.envelopeRecovery,
    envelopeAccount: material.envelopeAccount,
    accountRecoveryKey: encodeBase64Url(material.accountRecoveryKey),
    signPub: material.signPub,
    recoverSignPub: material.recoverSignPub,
  };
}

async function getSession(deps: PersonalSyncCommandDeps): Promise<SyncSessionPort | undefined> {
  if (!deps.auth.isLoggedIn()) {
    deps.ui.warn(l10n('sync.loginRequired'));
    return undefined;
  }
  // 先刷新权益和派生 userId；失败时 factory 会保持零 session/零 sync 请求。
  await deps.auth.refreshEntitlement();
  let session: SyncSessionPort | undefined;
  try {
    session = await deps.factory.ensureSession();
  } catch {
    deps.ui.error(l10n('sync.sessionUnavailable'));
    return undefined;
  }
  if (!session) deps.ui.warn(l10n('sync.loginRequired'));
  return session;
}

async function existingState(session: SyncSessionPort): Promise<StateDto | undefined> {
  try {
    return await session.getRemoteState();
  } catch (err) {
    if (err instanceof SyncApiError && err.status === 400 && err.code === 'SYNC_NOT_INITIALIZED') return undefined;
    throw err;
  }
}

function reportInitialRun(ui: SyncUi, result: SyncRun): void {
  if (result?.stage === 'ok') {
    ui.info(l10n('sync.ready'));
  } else {
    ui.warn(l10n('sync.initialSyncPending'));
  }
}

async function runFirstSync(session: SyncSessionPort, ui: SyncUi): Promise<void> {
  try {
    reportInitialRun(ui, await session.syncNow());
  } catch {
    ui.warn(l10n('sync.initialSyncPending'));
  }
}

function validateNewSmp(smp: string, ui: SyncUi): boolean {
  if (smp.trim().length === 0) {
    ui.error(l10n('sync.passphraseEmpty'));
    return false;
  }
  const codePoints = [...smp].length;
  if (codePoints < 9 || codePoints > 128) {
    ui.error(l10n('sync.passphraseLength'));
    return false;
  }
  return true;
}

/** 初始化路径：状态不存在才可执行；恢复码仅在远端及本地状态均成功后展示一次。 */
export async function initializePersonalSync(deps: PersonalSyncCommandDeps): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (session.isUnlocked) {
    deps.ui.info(l10n('sync.alreadyUnlocked'));
    return;
  }
  try {
    if (await existingState(session)) {
      deps.ui.info(l10n('sync.alreadyInitialized'));
      return;
    }
  } catch {
    deps.ui.error(l10n('sync.stateInvalid'));
    return;
  }

  const smp = await deps.ui.promptSmp(l10n('sync.createPassphrase'));
  if (!smp) return;
  if (!validateNewSmp(smp, deps.ui)) return;
  const confirmation = await deps.ui.promptSmp(l10n('sync.confirmPassphrase'));
  if (!confirmation) return;
  if (!validateNewSmp(confirmation, deps.ui)) return;
  if (smp !== confirmation) {
    deps.ui.error(l10n('sync.passphraseMismatch'));
    return;
  }

  const recovery = (deps.newRecoveryCode ?? newRecoveryCode)();
  let material: InitialSyncMaterial | undefined;
  try {
    material = await (deps.createMaterial ?? createInitialMaterial)(session.uid, '1', smp, recovery.raw);
    await session.initializeSync(newStateFrom(material), material.dek);
  } catch (err) {
    if (err instanceof SyncApiError && err.code === 'SYNC_STATE_EXISTS') {
      deps.ui.warn(l10n('sync.initializationRaced'));
    } else if (material) {
      // init 的网络结果或远端成功后的本机落盘状态可能未知，不能鼓励再次 init。
      deps.ui.warn(l10n('sync.initializationUncertain'));
    } else {
      deps.ui.error(l10n('sync.initializationFailed'));
    }
    return;
  } finally {
    // session 已复制其拥有的 DEK；命令层材料和恢复码熵随后不应继续驻留。
    recovery.raw.fill(0);
    material?.dek.fill(0);
    material?.accountRecoveryKey.fill(0);
  }
  // Recovery code is only available in this in-memory flow. A dismissed modal is not confirmation:
  // keep prompting until the user explicitly acknowledges saving it before reporting success.
  while (!await deps.ui.confirmRecoveryCode(recovery.code)) {
    deps.ui.warn(l10n('sync.recoveryCodeMustConfirm'));
  }
  await runFirstSync(session, deps.ui);
}

/** 解锁路径：先严格校验远端 state，再通过 SMP 解开 DEK，任何失败均保持 session locked。 */
export async function unlockPersonalSync(deps: PersonalSyncCommandDeps): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (session.isUnlocked) {
    if (!session.epochStale) {
      deps.ui.info(l10n('sync.alreadyUnlocked'));
      return;
    }
    // 远端 epoch 已前进（他设备 destroy/reset）：先 lock 丢弃旧 epoch 的 DEK，再走下方 SMP 重新解锁。
    session.lock();
  }
  let state: StateDto | undefined;
  try {
    state = await existingState(session);
  } catch {
    deps.ui.error(l10n('sync.stateInvalid'));
    return;
  }
  if (!state) {
    deps.ui.info(l10n('sync.notInitialized'));
    return;
  }

  const smp = await deps.ui.promptSmp(l10n('sync.enterPassphrase'));
  if (!smp) return;
  let dek: Uint8Array | undefined;
  try {
    const hadPendingCleanup = session.pendingCleanup !== undefined;
    dek = await (deps.unlockDek ?? ((uid, epoch, passphrase, remote) => unlockDek(uid, epoch, passphrase, remote.smpKdf, remote.envelopeSmp)))(session.uid, state.keyEpoch, smp, state);
    await session.unlockFromState(state, dek);
    if (hadPendingCleanup) deps.ui.info(l10n('sync.cleanupResumed'));
  } catch {
    // reset 场景：他设备旧 SMP 解封新 epoch 必然 GCM 失败——给出本地清理逃生舱入口。
    // epochStale 依赖 coordinator.lastRun，重启后恒 false；补 localEpoch < remote 的判定覆盖常见实例。
    const staleHint = session.epochStale
      || (session.localEpoch !== undefined && BigInt(session.localEpoch) < BigInt(state.keyEpoch));
    if (staleHint && deps.ui.errorAction) {
      const act = await deps.ui.errorAction(l10n('sync.unlockEpochStale'), l10n('sync.clearLocalAction'));
      if (act) void vscode.commands.executeCommand('dbclient.clearLocalSync');
    } else {
      deps.ui.error(l10n('sync.unlockFailed'));
    }
    return;
  } finally {
    dek?.fill(0);
  }
  // 解锁即由 unlockFromState 内部排首次后台同步（scheduleInitialSync）；
  // 命令层不再重复 syncNow（避免双轮），同步结果经状态栏/onSyncResult 异步反馈。
  deps.ui.info(l10n('sync.unlocked'));
}

/** 智能同步入口（树视图「⋯」菜单的「同步」项）：已解锁→立即同步；已初始化锁定→解锁；未初始化→初始化。 */
export async function syncEntry(deps: PersonalSyncCommandDeps): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (session.isUnlocked) {
    try {
      reportInitialRun(deps.ui, await session.syncNow());
    } catch {
      deps.ui.warn(l10n('sync.initialSyncPending'));
    }
    return;
  }
  // 本地 localEpoch 只是本机是否已持久化的指示，不能可靠区分「已初始化但本机无快照（第二台设备）」
  // 与「从未初始化」。这里探测远端 state 决定走解锁还是初始化。
  let state: StateDto | undefined;
  try {
    state = await existingState(session);
  } catch {
    deps.ui.error(l10n('sync.stateInvalid'));
    return;
  }
  if (state) await unlockPersonalSync(deps);
  else await initializePersonalSync(deps);
}

function vscodeUi(): SyncUi {
  return {
    promptSmp: (prompt) => vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true }),
    confirmRecoveryCode: async (code) => {
      const confirmed = await vscode.window.showWarningMessage(
        l10n('sync.recoveryCode', { code }),
        { modal: true },
        l10n('sync.recoveryCodeConfirmed'),
      );
      return confirmed === l10n('sync.recoveryCodeConfirmed');
    },
    info: (message) => { void vscode.window.showInformationMessage(message); },
    warn: (message) => { void vscode.window.showWarningMessage(message); },
    error: (message) => { void vscode.window.showErrorMessage(message); },
    errorAction: (message, actionLabel) => vscode.window.showErrorMessage(message, actionLabel),
  };
}

export function registerPersonalSyncCommands(
  context: vscode.ExtensionContext,
  auth: AuthService,
  factory: SyncSessionFactory,
): void {
  const deps: PersonalSyncCommandDeps = { auth, factory, ui: vscodeUi() };
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.initializePersonalSync', () => initializePersonalSync(deps)),
    vscode.commands.registerCommand('dbclient.unlockPersonalSync', () => unlockPersonalSync(deps)),
    vscode.commands.registerCommand('dbclient.syncEntry', () => syncEntry(deps)),
  );
}

export type { SyncSessionPort, SyncUi };
