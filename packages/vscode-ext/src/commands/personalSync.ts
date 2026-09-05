import * as vscode from 'vscode';
import type { AuthService } from '../sync/authService';
import { SyncApiError } from '../sync/e2e/client';
import type { StateDto, NewStateDto } from '../sync/e2e/types';
import type { InitialSyncMaterial } from '../sync/keyLifecycle';
import { createInitialMaterial, newRecoveryCode, unlockDek } from '../sync/keyLifecycle';
import type { SyncSessionFactory } from '../sync/sessionFactory';
import { l10n } from '../i18n';

type SyncRun = { stage: string } | undefined;

interface SyncSessionPort {
  readonly uid: string;
  readonly isUnlocked: boolean;
  readonly pendingCleanup: { fromKeyEpoch: string; toKeyEpoch: string } | undefined;
  getRemoteState(): Promise<StateDto>;
  initializeSync(newState: NewStateDto, dek: Uint8Array): Promise<void>;
  unlockFromState(state: StateDto, dek: Uint8Array): Promise<void>;
  syncNow(): Promise<SyncRun>;
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
  if (codePoints < 12 || codePoints > 128) {
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
    deps.ui.info(l10n('sync.alreadyUnlocked'));
    return;
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
    deps.ui.error(l10n('sync.unlockFailed'));
    return;
  } finally {
    dek?.fill(0);
  }
  await runFirstSync(session, deps.ui);
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
  );
}

export type { SyncSessionPort, SyncUi };
