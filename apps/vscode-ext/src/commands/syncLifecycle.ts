import * as vscode from 'vscode';
import { createHash } from 'crypto';
import type { AuthService } from '../sync/authService';
import type { SyncSessionFactory } from '@devkit/db-host/sync/sessionFactory';
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
  recoverByAccount(accountPassword: string, newSmp: string): Promise<string>;
  destroySync(smp: string): Promise<string>;
  requestResetChallenge(): Promise<void>;
  resetSyncAfterLoss(handoffTicket: string, newSmp: string): Promise<string>;
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
  if (codePoints < 9 || codePoints > 128) {
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

/**
 * 通过账号恢复（锁定态，忘记口令+恢复码）：先以账户登录口令自证 → 服务端下发账号
 * 钥匙 → 解 DEK → 新口令双输入 → 重设三把钥匙并恢复，成功后展示新恢复码。数据不丢。
 */
export async function recoverByAccountCommand(deps: SyncLifecycleCommandDeps): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (session.isUnlocked) {
    deps.ui.info(l10n('sync.alreadyUnlocked'));
    return;
  }
  // 账号恢复会经由服务端下发 DEK 解密原材料，必须先以账户登录口令自证身份，
  // 防止仅有 sync token 的泄露者离线解密全部同步数据。
  const accountPassword = await deps.ui.promptSmp(l10n('sync.accountRecoveryPassword'));
  if (!accountPassword) return;
  const newSmp = await promptNewSmpTwice(deps.ui);
  if (!newSmp) return;
  let newRecovery: string;
  try {
    newRecovery = await session.recoverByAccount(accountPassword, newSmp);
  } catch {
    deps.ui.error(l10n('sync.recoverByAccountFailed'));
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

/**
 * 忘记同步口令（锁定态）：发送邮件挑战。后续交接（浏览器认领 → 深链 → 扩展消费
 * handoffTicket）由 syncResetFromHandoff 完成，命令层**不再**收集重置 token。
 */
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
}

/**
 * 扩展消费浏览器深链带来的 handoffTicket（锁定态）：新 SMP 双输入 → 服务端最终 reset。
 * ticket 仅存在于本函数参数（内存）；成功或终态失败后随函数返回自然释放，不写
 * globalState/SecretStorage/日志。日志/错误上报只允许 `handoff:<8hex>` 前缀。
 */
export async function resetSyncFromHandoff(deps: SyncLifecycleCommandDeps, handoffTicket: string): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (session.isUnlocked) {
    deps.ui.warn(l10n('sync.resetHandoffRequiresLocked'));
    return;
  }
  if (session.pendingCleanup) {
    deps.ui.warn(l10n('sync.resetPendingCleanup'));
    return;
  }
  const newSmp = await promptNewSmpTwice(deps.ui);
  if (!newSmp) return;
  let newRecovery: string;
  try {
    newRecovery = await session.resetSyncAfterLoss(handoffTicket, newSmp);
  } catch {
    deps.ui.error(l10n('sync.resetHandoffFailed'));
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
    vscode.commands.registerCommand('devbelt.changeSyncPassword', () => changeSyncPassword(deps)),
    vscode.commands.registerCommand('devbelt.recoverSync', () => recoverSync(deps)),
    vscode.commands.registerCommand('devbelt.recoverByAccount', () => recoverByAccountCommand(deps)),
    vscode.commands.registerCommand('devbelt.destroySync', () => destroySync(deps)),
    vscode.commands.registerCommand('devbelt.resetSync', () => resetSync(deps)),
  );
}

/** ticket 脱敏：只输出 SHA-256 前 8 hex 前缀（日志/错误上报不得含完整 ticket）。 */
function redactHandoffTicket(ticket: string): string {
  return `handoff:${createHash('sha256').update(ticket).digest('hex').slice(0, 8)}...`;
}

/**
 * sync-reset 深链 UriHandler（P3 切片 5，§5.4）：`vscode://<id>/reset-after-loss?handoffTicket=`。
 * ticket 仅经参数传入 resetSyncFromHandoff（内存），绝不写 globalState/SecretStorage；
 * 日志仅记录脱敏前缀。未匹配路径的 URI 静默忽略。
 */
export function registerSyncResetUriHandler(
  context: vscode.ExtensionContext,
  auth: AuthService,
  factory: SyncSessionFactory,
): void {
  const deps: SyncLifecycleCommandDeps = { auth, factory, ui: vscodeUi() };
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri): Promise<void> {
        if (uri.path !== '/reset-after-loss') return;
        const ticket = uri.query ? new URLSearchParams(uri.query).get('handoffTicket') : null;
        console.log(`[sync] reset handoff URI received: ${ticket ? redactHandoffTicket(ticket) : '(missing ticket)'}`);
        // 快速拒绝缺失/畸形 ticket（256bit = 43 字符 base64url），不进入 SMP 输入、不建 session。
        if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
          deps.ui.error(l10n('sync.resetHandoffInvalid'));
          return;
        }
        await resetSyncFromHandoff(deps, ticket);
      },
    }),
  );
}

export type { SyncLifecycleSessionPort };
