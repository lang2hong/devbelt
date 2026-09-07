import * as vscode from 'vscode';
import type { AuthService } from '../sync/authService';
import type { SyncSessionFactory } from '../sync/sessionFactory';
import { l10n } from '../i18n';

/**
 * B5 生命周期命令：换钥 / 恢复码恢复 / 销毁同步数据 / 丢失口令重置。
 *
 * 命令层只收集口令、恢复码、重置 token 等敏感输入并做表单校验；密钥材料
 * （DEK/KEK/sign seed/恢复码 raw）的派生与签名全部留在 PersonalSyncSession 内，
 * 命令层不接触私钥。取消、校验失败、API 失败均不写本地状态；错误只回显固定本地化文案。
 */

interface SyncLifecycleSessionPort {
  readonly isUnlocked: boolean;
  readonly pendingCleanup: { fromKeyEpoch: string; toKeyEpoch: string } | undefined;
  changeSyncPassword(oldSmp: string, newSmp: string): Promise<void>;
  recoverSync(recoveryCode: string, newSmp: string): Promise<string>;
  destroySync(smp: string): Promise<string>;
  requestResetChallenge(): Promise<void>;
  resetSyncAfterLoss(resetToken: string, newSmp: string): Promise<string>;
}

interface SyncLifecycleFactoryPort {
  ensureSession(): Promise<SyncLifecycleSessionPort | undefined>;
}

export interface SyncLifecycleUi {
  promptSmp(prompt: string): PromiseLike<string | undefined>;
  promptText(prompt: string): PromiseLike<string | undefined>;
  confirmIrreversible(message: string, confirmLabel: string): PromiseLike<boolean>;
  confirmRecoveryCode(code: string): PromiseLike<boolean>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SyncLifecycleCommandDeps {
  auth: Pick<AuthService, 'isLoggedIn' | 'refreshEntitlement'>;
  factory: SyncLifecycleFactoryPort;
  ui: SyncLifecycleUi;
}

function validateNewSmp(smp: string, ui: SyncLifecycleUi): boolean {
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

async function getSession(deps: SyncLifecycleCommandDeps): Promise<SyncLifecycleSessionPort | undefined> {
  if (!deps.auth.isLoggedIn()) {
    deps.ui.warn(l10n('sync.loginRequired'));
    return undefined;
  }
  await deps.auth.refreshEntitlement();
  try {
    return await deps.factory.ensureSession();
  } catch {
    deps.ui.error(l10n('sync.sessionUnavailable'));
    return undefined;
  }
}

/** 新口令双输入 + 校验，返回口令或 undefined。 */
async function promptNewSmpTwice(ui: SyncLifecycleUi): Promise<string | undefined> {
  const smp = await ui.promptSmp(l10n('sync.newPassphrase'));
  if (!smp) return undefined;
  if (!validateNewSmp(smp, ui)) return undefined;
  const confirmation = await ui.promptSmp(l10n('sync.confirmPassphrase'));
  if (!confirmation) return undefined;
  if (!validateNewSmp(confirmation, ui)) return undefined;
  if (smp !== confirmation) {
    ui.error(l10n('sync.passphraseMismatch'));
    return undefined;
  }
  return smp;
}

/** 一次性展示新恢复码并强制用户确认已保存（未确认则反复提示）。 */
async function confirmNewRecoveryCode(ui: SyncLifecycleUi, code: string): Promise<void> {
  while (!(await ui.confirmRecoveryCode(code))) {
    ui.warn(l10n('sync.recoveryCodeMustConfirm'));
  }
}

/** 修改同步口令（解锁态）：旧 SMP + 新 SMP 双输入。 */
export async function changeSyncPassword(deps: SyncLifecycleCommandDeps): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (!session.isUnlocked) {
    deps.ui.warn(l10n('sync.requiresUnlock'));
    return;
  }
  const oldSmp = await deps.ui.promptSmp(l10n('sync.currentPassphrase'));
  if (!oldSmp) return;
  const newSmp = await promptNewSmpTwice(deps.ui);
  if (!newSmp) return;
  try {
    await session.changeSyncPassword(oldSmp, newSmp);
  } catch {
    deps.ui.error(l10n('sync.changePassphraseFailed'));
    return;
  }
  deps.ui.info(l10n('sync.changePassphraseSuccess'));
}

/** 使用恢复码恢复（锁定态）：恢复码 + 新 SMP 双输入，成功后展示并确认新恢复码。 */
export async function recoverSync(deps: SyncLifecycleCommandDeps): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (session.isUnlocked) {
    deps.ui.info(l10n('sync.alreadyUnlocked'));
    return;
  }
  const code = await deps.ui.promptText(l10n('sync.enterRecoveryCode'));
  if (!code) return;
  const newSmp = await promptNewSmpTwice(deps.ui);
  if (!newSmp) return;
  let newRecovery: string;
  try {
    newRecovery = await session.recoverSync(code, newSmp);
  } catch {
    deps.ui.error(l10n('sync.recoverFailed'));
    return;
  }
  await confirmNewRecoveryCode(deps.ui, newRecovery);
  deps.ui.info(l10n('sync.unlocked'));
}

/** 销毁同步数据（解锁态）：不可逆警告 + 二次确认 + 当前 SMP 校验，成功后展示新恢复码。 */
export async function destroySync(deps: SyncLifecycleCommandDeps): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (!session.isUnlocked) {
    deps.ui.warn(l10n('sync.requiresUnlock'));
    return;
  }
  if (!(await deps.ui.confirmIrreversible(l10n('sync.destroyConfirm'), l10n('sync.destroyConfirmButton')))) return;
  const smp = await deps.ui.promptSmp(l10n('sync.destroyCurrentPassphrase'));
  if (!smp) return;
  let newRecovery: string;
  try {
    newRecovery = await session.destroySync(smp);
  } catch {
    deps.ui.error(l10n('sync.destroyFailed'));
    return;
  }
  await confirmNewRecoveryCode(deps.ui, newRecovery);
  deps.ui.info(l10n('sync.destroySuccess'));
}

/** 忘记同步口令（锁定态）：邮件挑战 → 重置 token + 新 SMP，成功后展示新恢复码。 */
export async function resetSync(deps: SyncLifecycleCommandDeps): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (session.isUnlocked) {
    deps.ui.warn(l10n('sync.resetRequiresLocked'));
    return;
  }
  if (session.pendingCleanup) {
    deps.ui.warn(l10n('sync.resetPendingCleanup'));
    return;
  }
  if (!(await deps.ui.confirmIrreversible(l10n('sync.resetConfirm'), l10n('sync.resetConfirmButton')))) return;
  try {
    await session.requestResetChallenge();
  } catch {
    deps.ui.error(l10n('sync.resetChallengeFailed'));
    return;
  }
  deps.ui.info(l10n('sync.resetChallengeSent'));
  const token = await deps.ui.promptText(l10n('sync.enterResetToken'));
  if (!token) return;
  const newSmp = await promptNewSmpTwice(deps.ui);
  if (!newSmp) return;
  let newRecovery: string;
  try {
    newRecovery = await session.resetSyncAfterLoss(token, newSmp);
  } catch (err) {
    void err;
    deps.ui.error(l10n('sync.resetFailed'));
    return;
  }
  await confirmNewRecoveryCode(deps.ui, newRecovery);
  deps.ui.info(l10n('sync.unlocked'));
}

function vscodeUi(): SyncLifecycleUi {
  return {
    promptSmp: (prompt) => vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true }),
    promptText: (prompt) => vscode.window.showInputBox({ prompt, ignoreFocusOut: true }),
    confirmIrreversible: async (message, confirmLabel) => {
      const chosen = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
      return chosen === confirmLabel;
    },
    confirmRecoveryCode: async (code) => {
      const chosen = await vscode.window.showWarningMessage(
        l10n('sync.recoveryCode', { code }),
        { modal: true },
        l10n('sync.recoveryCodeConfirmed'),
      );
      return chosen === l10n('sync.recoveryCodeConfirmed');
    },
    info: (message) => { void vscode.window.showInformationMessage(message); },
    warn: (message) => { void vscode.window.showWarningMessage(message); },
    error: (message) => { void vscode.window.showErrorMessage(message); },
  };
}

export function registerSyncLifecycleCommands(
  context: vscode.ExtensionContext,
  auth: AuthService,
  factory: SyncSessionFactory,
): void {
  const deps: SyncLifecycleCommandDeps = { auth, factory, ui: vscodeUi() };
  context.subscriptions.push(
    vscode.commands.registerCommand('dbclient.changeSyncPassword', () => changeSyncPassword(deps)),
    vscode.commands.registerCommand('dbclient.recoverSync', () => recoverSync(deps)),
    vscode.commands.registerCommand('dbclient.destroySync', () => destroySync(deps)),
    vscode.commands.registerCommand('dbclient.resetSync', () => resetSync(deps)),
  );
}

export type { SyncLifecycleSessionPort };