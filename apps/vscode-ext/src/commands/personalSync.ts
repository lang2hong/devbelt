import * as vscode from 'vscode';
import type { AuthService } from '../sync/authService';
import { SyncApiError } from '@devbelt/db-host/sync/e2e/client';
import type { StateDto, NewStateDto } from '@devbelt/db-host/sync/e2e/types';
import type { InitialSyncMaterial } from '@devbelt/db-host/sync/keyLifecycle';
import { createInitialMaterial, newRecoveryCode, unlockDek } from '@devbelt/db-host/sync/keyLifecycle';
import { encodeBase64Url } from '@devbelt/db-host/sync/crypto/recoveryCode';
import type { SyncSessionFactory } from '@devbelt/db-host/sync/sessionFactory';
import { canUseDataSync } from '@devbelt/db-host/sync/entitlementGate';
import type { FindingsReport } from '@devbelt/db-host/sync/e2e/syncEngine';
import { l10n } from '../i18n';
import { diagError, diagInfo } from '../utils/diagnostics';

type SyncRun = { stage: string; applied?: number; pushed?: number; changes?: number; skippedEntitlement?: number; skippedUnsupported?: number; skippedOutbound?: number; skippedOutboundReason?: string } | undefined;

interface SyncSessionPort {
  readonly uid: string;
  readonly isUnlocked: boolean;
  readonly pendingCleanup: { fromKeyEpoch: string; toKeyEpoch: string } | undefined;
  readonly epochStale: boolean;
  readonly localEpoch: string | undefined;
  getRemoteState(): Promise<StateDto>;
  initializeSync(newState: NewStateDto, dek: Uint8Array): Promise<void>;
  unlockFromState(state: StateDto, dek: Uint8Array): Promise<void>;
  tryRestoreUnlock(): Promise<boolean>;
  syncNow(): Promise<SyncRun>;
  syncPull(): Promise<SyncRun>;
  syncPush(): Promise<SyncRun>;
  /** 体检检测（只读，零写入）：逐条列出本地与云端的不一致。 */
  inspectFindings(): Promise<FindingsReport>;
  /** 当前未解决冲突数（体检通知合并计数用）。 */
  listConflicts(): Array<{ recordId: string }>;
  lock(): void;
  /** 纯本地重置：清空本机同步数据与 DEK，不发起任何 sync API 请求。 */
  clearLocalState(): Promise<void>;
}

interface SyncFactoryPort {
  ensureSession(): Promise<SyncSessionPort | undefined>;
}

interface SyncUi {
  promptSmp(prompt: string): PromiseLike<string | undefined>;
  confirmRecoveryCode(code: string): PromiseLike<boolean>;
  info(message: string): void;
  warn(message: string): void;
  /** 带单个动作按钮的警告；按钮内部动作固定为「同步体检」（不暴露命令细节给命令层）。 */
  warnAction?(message: string, action: string): void;
  error(message: string): void;
  /** 带多个动作按钮的错误提示；返回用户点中的按钮 label（未点返回 undefined）。 */
  errorAction?(message: string, actions: string[]): PromiseLike<string | undefined>;
}

export interface PersonalSyncCommandDeps {
  auth: Pick<AuthService, 'isLoggedIn' | 'refreshEntitlement' | 'getCachedEntitlement'>;
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

/**
 * 本地重置用的会话解析：**不刷新权益**（refreshEntitlement 会打网络），
 * 以便远端不可达时仍能清本机状态。仅从已登录态与本地工厂派生。
 */
async function getSessionForLocalReset(deps: PersonalSyncCommandDeps): Promise<SyncSessionPort | undefined> {
  if (!deps.auth.isLoggedIn()) {
    deps.ui.warn(l10n('sync.loginRequired'));
    return undefined;
  }
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

type SyncOp = 'sync' | 'pull' | 'push';

/** 出站跳过原因 → 展示文案。S7l.1 后已无已知跳过原因（ES 已接入同步）；有原因如实显示，避免谎报 unknown。 */
function skipReasonLabel(reason: string | undefined): string {
  return reason || l10n('sync.skipReasonUnknown');
}

function reportInitialRun(ui: SyncUi, result: SyncRun, op: SyncOp): void {
  if (result?.stage === 'conflict') {
    // 显式同步遇冲突：打开「数据体检」面板（冲突逐条选择保留本地/使用云端/合并）。
    void vscode.commands.executeCommand('devbelt.syncDoctor');
    return;
  }
  // 按操作类型分别提示：pull / push / 立即同步 不再共用同一句，结果可区分。
  if (result?.stage === 'ok') {
    // 有跳过时不再谎报「已完成」：明确告知哪一类（入站套餐跳过 / 出站未能编码）及条数。
    const parts: string[] = [];
    if (result.skippedEntitlement) parts.push(l10n('sync.skippedEntitlement', { count: String(result.skippedEntitlement) }));
    if (result.skippedUnsupported) parts.push(l10n('sync.skippedUnsupported', { count: String(result.skippedUnsupported) }));
    if (result.skippedOutbound) {
      parts.push(l10n('sync.skippedOutbound', {
        count: String(result.skippedOutbound),
        reason: skipReasonLabel(result.skippedOutboundReason),
      }));
    }
    if (parts.length) {
      ui.warn(l10n('sync.skipped', { detail: parts.join('；') }));
      return;
    }
    if ((result.changes ?? 0) + (result.pushed ?? 0) === 0) {
      ui.info(l10n(`sync.doneUpToDate.${op}`));
    } else ui.info(l10n(`sync.done.${op}`));
  } else {
    ui.warn(l10n(`sync.pending.${op}`));
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
  // 初始化是纯初始化：不自动同步。是否/何时同步由自动同步开关或显式命令决定。
  deps.ui.info(l10n('sync.initialized'));
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
  // 方案 B：先尝试从本地安全存储自动解锁（重启后免输口令）；失败再走口令解锁。
  if (await session.tryRestoreUnlock()) {
    deps.ui.info(l10n('sync.autoUnlocked'));
    await notifyFindings(deps, session);
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
  } catch (err) {
    // 诊断（真机排查）：catch 把「解封/落盘（Secrets/Memento）」多类失败压成同一文案，
    // 真实原因必须同时落日志与弹窗，否则"口令不一致"会掩盖非口令故障。
    const detail = err instanceof Error ? err.message : String(err);
    diagError(`sync unlock failed: ${detail}`);
    // 解锁失败分两类：
    //  - epoch 前进（他设备 destroy/reset）：旧口令对应旧数据，恢复码/账号也救不回，只能重置同步。
    //  - 口令不一致/输错（epoch 未变）：给出口令不一致 + 重新输入/恢复码/账号/重置四个动作。
    const staleHint = session.epochStale
      || (session.localEpoch !== undefined && BigInt(session.localEpoch) < BigInt(state.keyEpoch));
    if (deps.ui.errorAction) {
      if (staleHint) {
        const act = await deps.ui.errorAction(l10n('sync.unlockEpochStale'), [
          l10n('sync.resetSyncAction'), l10n('sync.resetLocalAction'),
        ]);
        if (act === l10n('sync.resetLocalAction')) void vscode.commands.executeCommand('devbelt.resetLocalSync');
        else if (act) void vscode.commands.executeCommand('devbelt.resetSync');
      } else {
        const act = await deps.ui.errorAction(`${l10n('sync.unlockPassphraseMismatch')}\n(${detail})`, [
          l10n('sync.retryEnter'), l10n('sync.useRecoveryCode'), l10n('sync.useAccount'),
          l10n('sync.resetSyncAction'), l10n('sync.resetLocalAction'),
        ]);
        if (act === l10n('sync.retryEnter')) await unlockPersonalSync(deps);
        else if (act === l10n('sync.useRecoveryCode')) void vscode.commands.executeCommand('devbelt.recoverSync');
        else if (act === l10n('sync.useAccount')) void vscode.commands.executeCommand('devbelt.recoverByAccount');
        else if (act === l10n('sync.resetLocalAction')) void vscode.commands.executeCommand('devbelt.resetLocalSync');
        else if (act === l10n('sync.resetSyncAction')) void vscode.commands.executeCommand('devbelt.resetSync');
      }
    } else {
      deps.ui.error(staleHint ? l10n('sync.unlockEpochStale') : `${l10n('sync.unlockFailed')}\n(${detail})`);
    }
    return;
  } finally {
    dek?.fill(0);
  }
  // 解锁是纯解锁：不自动同步。是否/何时同步由自动同步开关（聚焦/本地变更）或显式命令决定。
  await notifyFindings(deps, session);
  deps.ui.info(l10n('sync.unlocked'));
}

/**
 * 体检检测（只读，零写入）：发现或冲突 > 0 时通知用户去面板逐条选择处理；一致不打扰
 * （同步结果消息已明确反馈）。检测失败静默（诊断日志可见）。
 */
async function notifyFindings(deps: PersonalSyncCommandDeps, session: SyncSessionPort): Promise<void> {
  try {
    const report = await session.inspectFindings();
    const conflicts = session.listConflicts();
    const count = report.findings.length + conflicts.length;
    diagInfo('sync findings', {
      count,
      conflicts: conflicts.length,
      incomplete: report.incomplete,
      kinds: report.findings.map((f) => f.kind),
    });
    if (count <= 0 || report.incomplete) return;
    const message = l10n('sync.doctorNotify', { count: String(count) });
    const action = l10n('sync.doctorOpen');
    if (deps.ui.warnAction) deps.ui.warnAction(message, action);
    else deps.ui.warn(message);
  } catch {
    /* 检测失败不阻塞解锁/同步 */
  }
}

/**
 * 智能入口（「启用同步」）：按远端状态自动路由——远端有 state→解锁；无 state→初始化。
 * 二者都是纯动作，不自动同步（自动同步由开关或显式命令负责）。
 */
export async function syncEntry(deps: PersonalSyncCommandDeps): Promise<void> {
  const session = await getSession(deps);
  if (!session) return;
  if (session.isUnlocked) {
    deps.ui.info(l10n('sync.alreadyUnlocked'));
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

/** 显式 pull / push / 立即同步共用：需解锁，结果按操作类型反馈。 */
async function runExplicitSync(
  deps: PersonalSyncCommandDeps,
  op: SyncOp,
  run: (session: SyncSessionPort) => Promise<SyncRun>,
): Promise<void> {
  // 数据同步门禁：走统一 gate（仅当权益明确禁用时拦截，默认允许），不再用动态 cast。
  if (!canUseDataSync(deps.auth.getCachedEntitlement())) {
    deps.ui.warn(l10n('entitlement.dataSyncRequired'));
    return;
  }
  const session = await getSession(deps);
  if (!session) return;
  if (!session.isUnlocked) {
    deps.ui.warn(l10n('sync.requiresUnlock'));
    return;
  }
  diagInfo('sync trigger', { trigger: `manual-${op}`, autoSync: false });
  try {
    const result = await run(session);
    reportInitialRun(deps.ui, result, op);
    // 同步结果反馈后做一次体检检测：发现不一致 → 通知用户去面板逐条选择处理。
    if (result?.stage === 'ok') {
      await notifyFindings(deps, session);
    }
  } catch {
    deps.ui.warn(l10n(`sync.pending.${op}`));
  }
}

/** 仅拉取远端（pull）。 */
export async function pullPersonalSync(deps: PersonalSyncCommandDeps): Promise<void> {
  await runExplicitSync(deps, 'pull', (session) => session.syncPull());
}

/** 仅推送本地变更（push）。 */
export async function pushPersonalSync(deps: PersonalSyncCommandDeps): Promise<void> {
  await runExplicitSync(deps, 'push', (session) => session.syncPush());
}

/** 立即同步（显式，等待并反馈结果）。 */
export async function syncNowPersonalSync(deps: PersonalSyncCommandDeps): Promise<void> {
  await runExplicitSync(deps, 'sync', (session) => session.syncNow());
}

/**
 * 本地重置：清本机同步数据与 DEK，回到未初始化态；不联系服务器。
 * 与远端 resetSync（需浏览器 handoff）并列，供远端不可达 / stale-epoch 时逃生。
 */
export async function resetLocalSync(deps: PersonalSyncCommandDeps): Promise<void> {
  const session = await getSessionForLocalReset(deps);
  if (!session) return;
  const action = l10n('sync.resetLocalAction');
  const confirmed = deps.ui.errorAction
    ? await deps.ui.errorAction(l10n('sync.resetLocalConfirm'), [action])
    : undefined;
  if (confirmed !== action) return;
  await session.clearLocalState();
  deps.ui.info(l10n('sync.resetLocalDone'));
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
    warnAction: (message, action) => {
      void vscode.window.showWarningMessage(message, action).then((picked) => {
        if (picked === action) void vscode.commands.executeCommand('devbelt.syncDoctor');
      });
    },
    error: (message) => { void vscode.window.showErrorMessage(message); },
    errorAction: (message, actions) => vscode.window.showErrorMessage(message, ...actions),
  };
}

export function registerPersonalSyncCommands(
  context: vscode.ExtensionContext,
  auth: AuthService,
  factory: SyncSessionFactory,
): void {
  const deps: PersonalSyncCommandDeps = { auth, factory, ui: vscodeUi() };
  context.subscriptions.push(
    vscode.commands.registerCommand('devbelt.initializePersonalSync', () => initializePersonalSync(deps)),
    vscode.commands.registerCommand('devbelt.unlockPersonalSync', () => unlockPersonalSync(deps)),
    vscode.commands.registerCommand('devbelt.syncEntry', () => syncEntry(deps)),
    vscode.commands.registerCommand('devbelt.syncPull', () => pullPersonalSync(deps)),
    vscode.commands.registerCommand('devbelt.syncPush', () => pushPersonalSync(deps)),
    vscode.commands.registerCommand('devbelt.syncNow', () => syncNowPersonalSync(deps)),
    vscode.commands.registerCommand('devbelt.resetLocalSync', () => resetLocalSync(deps)),
    // legacy alias：该命令曾叫 clearLocalSync，用户可能已绑快捷键/引用此 id。
    // 保留注册以免重命名后旧快捷键静默失效（不在 package.json 声明，故不出现在命令面板）。
    vscode.commands.registerCommand('devbelt.clearLocalSync', () => resetLocalSync(deps)),
  );
}

export type { SyncSessionPort, SyncUi };
