import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
  window: {
    registerUriHandler: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  commands: {},
}));

import {
  changeSyncPassword,
  recoverSync,
  recoverByAccountCommand,
  destroySync,
  resetSync,
  resetSyncFromHandoff,
  registerSyncResetUriHandler,
  type SyncLifecycleCommandDeps,
} from '../../src/commands/syncLifecycle';

function makeSession(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    isUnlocked: false,
    pendingCleanup: undefined,
    changeSyncPassword: vi.fn(async () => {}),
    recoverSync: vi.fn(async () => 'NEWCODE'),
    recoverByAccount: vi.fn(async () => 'NEWCODE'),
    destroySync: vi.fn(async () => 'NEWCODE'),
    requestResetChallenge: vi.fn(async () => {}),
    resetSyncAfterLoss: vi.fn(async () => 'NEWCODE'),
    ...over,
  };
}

function makeDeps(session: ReturnType<typeof makeSession>, over?: { loggedIn?: boolean }): { deps: SyncLifecycleCommandDeps; ui: ReturnType<typeof makeUi> } {
  const ui = makeUi();
  const deps = {
    auth: { isLoggedIn: () => over?.loggedIn ?? true, refreshEntitlement: vi.fn(async () => {}) },
    factory: { ensureSession: vi.fn(async () => session) },
    ui,
  } as unknown as SyncLifecycleCommandDeps;
  return { deps, ui };
}

function makeUi() {
  return {
    promptSmp: vi.fn(),
    promptText: vi.fn(),
    confirmIrreversible: vi.fn(async () => true),
    confirmRecoveryCode: vi.fn(async () => true),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('syncLifecycle 命令（B5）', () => {
  it('changeSyncPassword：未解锁 → 告警且不调用 session', async () => {
    const session = makeSession({ isUnlocked: false });
    const { deps, ui } = makeDeps(session);
    await changeSyncPassword(deps);
    expect(session.changeSyncPassword).not.toHaveBeenCalled();
    expect(ui.warn).toHaveBeenCalled();
  });

  it('changeSyncPassword：旧口令取消 → 中止', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValue(undefined);
    await changeSyncPassword(deps);
    expect(session.changeSyncPassword).not.toHaveBeenCalled();
  });

  it('changeSyncPassword：双输入不匹配 → 报错且不调用 session', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValueOnce('old').mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('different-passphrase');
    await changeSyncPassword(deps);
    expect(ui.error).toHaveBeenCalled();
    expect(session.changeSyncPassword).not.toHaveBeenCalled();
  });

  it('changeSyncPassword：成功 → 调用 session + 提示成功', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValueOnce('old').mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    await changeSyncPassword(deps);
    expect(session.changeSyncPassword).toHaveBeenCalledWith('old', 'new-passphrase-123');
    expect(ui.info).toHaveBeenCalled();
  });

  it('changeSyncPassword：session 失败 → 固定错误且不落本地', async () => {
    const session = makeSession({ isUnlocked: true, changeSyncPassword: vi.fn(async () => { throw new Error('x'); }) });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValueOnce('old').mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    await changeSyncPassword(deps);
    expect(ui.error).toHaveBeenCalled();
  });

  it('recoverSync：成功 → 展示新恢复码并确认后解锁提示', async () => {
    const session = makeSession({ isUnlocked: false, recoverSync: vi.fn(async () => 'CODE-XYZ') });
    const { deps, ui } = makeDeps(session);
    ui.promptText.mockResolvedValue('A'.repeat(43));
    ui.promptSmp.mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    await recoverSync(deps);
    expect(session.recoverSync).toHaveBeenCalledWith('A'.repeat(43), 'new-passphrase-123');
    expect(ui.confirmRecoveryCode).toHaveBeenCalledWith('CODE-XYZ');
    expect(ui.info).toHaveBeenCalled();
  });

  it('recoverSync：失败 → 固定错误，不展示恢复码', async () => {
    const session = makeSession({ isUnlocked: false, recoverSync: vi.fn(async () => { throw new Error('bad code'); }) });
    const { deps, ui } = makeDeps(session);
    ui.promptText.mockResolvedValue('x');
    ui.promptSmp.mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    await recoverSync(deps);
    expect(ui.error).toHaveBeenCalled();
    expect(ui.confirmRecoveryCode).not.toHaveBeenCalled();
  });

  it('recoverByAccountCommand：未登录 → 告警且不调用 session', async () => {
    const session = makeSession({ isUnlocked: false });
    const { deps, ui } = makeDeps(session, { loggedIn: false });
    await recoverByAccountCommand(deps);
    expect(session.recoverByAccount).not.toHaveBeenCalled();
    expect(ui.warn).toHaveBeenCalled();
  });

  it('recoverByAccountCommand：已解锁 → 提示已解锁，不调用 session', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps, ui } = makeDeps(session);
    await recoverByAccountCommand(deps);
    expect(session.recoverByAccount).not.toHaveBeenCalled();
    expect(ui.info).toHaveBeenCalled();
  });

  it('recoverByAccountCommand：账户登录口令取消 → 中止，不调用 session', async () => {
    const session = makeSession({ isUnlocked: false });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValue(undefined);
    await recoverByAccountCommand(deps);
    expect(session.recoverByAccount).not.toHaveBeenCalled();
  });

  it('recoverByAccountCommand：新口令取消 → 中止，不调用 session', async () => {
    const session = makeSession({ isUnlocked: false });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValueOnce('account-password').mockResolvedValue(undefined);
    await recoverByAccountCommand(deps);
    expect(session.recoverByAccount).not.toHaveBeenCalled();
  });

  it('recoverByAccountCommand：成功 → 展示新恢复码并确认后解锁提示', async () => {
    const session = makeSession({ isUnlocked: false, recoverByAccount: vi.fn(async () => 'CODE-ACCT') });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValueOnce('account-password').mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    await recoverByAccountCommand(deps);
    expect(session.recoverByAccount).toHaveBeenCalledWith('account-password', 'new-passphrase-123');
    expect(ui.confirmRecoveryCode).toHaveBeenCalledWith('CODE-ACCT');
    expect(ui.info).toHaveBeenCalled();
  });

  it('recoverByAccountCommand：失败 → 固定错误，不展示恢复码', async () => {
    const session = makeSession({ isUnlocked: false, recoverByAccount: vi.fn(async () => { throw new Error('boom'); }) });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValueOnce('account-password').mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    await recoverByAccountCommand(deps);
    expect(ui.error).toHaveBeenCalled();
    expect(ui.confirmRecoveryCode).not.toHaveBeenCalled();
  });

  it('destroySync：取消二次确认 → 不输入口令、不调用 session', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps, ui } = makeDeps(session);
    ui.confirmIrreversible.mockResolvedValue(false);
    await destroySync(deps);
    expect(ui.promptSmp).not.toHaveBeenCalled();
    expect(session.destroySync).not.toHaveBeenCalled();
  });

  it('destroySync：成功 → 二次确认 + 口令校验 + 展示新恢复码', async () => {
    const session = makeSession({ isUnlocked: true, destroySync: vi.fn(async () => 'CODE-ABC') });
    const { deps, ui } = makeDeps(session);
    ui.confirmIrreversible.mockResolvedValue(true);
    ui.promptSmp.mockResolvedValue('smp');
    await destroySync(deps);
    expect(session.destroySync).toHaveBeenCalledWith('smp');
    expect(ui.confirmRecoveryCode).toHaveBeenCalledWith('CODE-ABC');
  });

  it('resetSync：challenge 发送后仅提示查邮件，不再收集 token、不再本地 reset', async () => {
    const session = makeSession({ isUnlocked: false });
    const { deps, ui } = makeDeps(session);
    ui.confirmIrreversible.mockResolvedValue(true);
    await resetSync(deps);
    expect(session.requestResetChallenge).toHaveBeenCalledTimes(1);
    expect(ui.promptText).not.toHaveBeenCalled();
    expect(session.resetSyncAfterLoss).not.toHaveBeenCalled();
    expect(ui.info).toHaveBeenCalledWith(expect.stringContaining('mail'));
  });

  it('resetSync：challenge 失败 → 固定错误，不请求 token', async () => {
    const session = makeSession({ isUnlocked: false, requestResetChallenge: vi.fn(async () => { throw new Error('x'); }) });
    const { deps, ui } = makeDeps(session);
    ui.confirmIrreversible.mockResolvedValue(true);
    await resetSync(deps);
    expect(ui.error).toHaveBeenCalled();
    expect(ui.promptText).not.toHaveBeenCalled();
    expect(session.resetSyncAfterLoss).not.toHaveBeenCalled();
  });

  it('resetSyncFromHandoff：新 SMP 双输入 → handoffTicket 消费 → 展示恢复码', async () => {
    const session = makeSession({ isUnlocked: false, resetSyncAfterLoss: vi.fn(async () => 'CODE-HF') });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    await resetSyncFromHandoff(deps, 'HANDOFF-TICKET');
    expect(session.resetSyncAfterLoss).toHaveBeenCalledWith('HANDOFF-TICKET', 'new-passphrase-123');
    expect(ui.confirmRecoveryCode).toHaveBeenCalledWith('CODE-HF');
    expect(ui.info).toHaveBeenCalled();
  });

  it('resetSyncFromHandoff：消费失败 → 固定错误，不展示恢复码', async () => {
    const session = makeSession({ isUnlocked: false, resetSyncAfterLoss: vi.fn(async () => { throw new Error('x'); }) });
    const { deps, ui } = makeDeps(session);
    ui.promptSmp.mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    await resetSyncFromHandoff(deps, 'HANDOFF-TICKET');
    expect(ui.error).toHaveBeenCalled();
    expect(ui.confirmRecoveryCode).not.toHaveBeenCalled();
  });

  it('resetSyncFromHandoff：未登录 → 告警且不消费 ticket', async () => {
    const session = makeSession();
    const { deps, ui } = makeDeps(session, { loggedIn: false });
    await resetSyncFromHandoff(deps, 'HANDOFF-TICKET');
    expect(ui.warn).toHaveBeenCalled();
    expect(session.resetSyncAfterLoss).not.toHaveBeenCalled();
  });

  it('确认新恢复码未保存时会反复提示', async () => {
    const session = makeSession({ isUnlocked: false, recoverSync: vi.fn(async () => 'CODE-REPEAT') });
    const { deps, ui } = makeDeps(session);
    ui.promptText.mockResolvedValue('A'.repeat(43));
    ui.promptSmp.mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    ui.confirmRecoveryCode.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await recoverSync(deps);
    expect(ui.warn).toHaveBeenCalled(); // recoveryCodeMustConfirm
    expect(ui.confirmRecoveryCode).toHaveBeenCalledTimes(2);
  });

  it('resetSync：解锁态 → 告警且不请求 challenge', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps, ui } = makeDeps(session);
    await resetSync(deps);
    expect(session.requestResetChallenge).not.toHaveBeenCalled();
    expect(session.resetSyncAfterLoss).not.toHaveBeenCalled();
    expect(ui.warn).toHaveBeenCalled();
  });

  it('resetSync：pendingCleanup 存在 → 告警且请求 challenge 前中止', async () => {
    const session = makeSession({ isUnlocked: false, pendingCleanup: { fromKeyEpoch: '1', toKeyEpoch: '2' } });
    const { deps, ui } = makeDeps(session);
    await resetSync(deps);
    expect(session.requestResetChallenge).not.toHaveBeenCalled();
    expect(session.resetSyncAfterLoss).not.toHaveBeenCalled();
    expect(ui.warn).toHaveBeenCalled();
  });
});

describe('syncResetUriHandler', () => {
  beforeEach(() => {
    vi.mocked(vscode.window.registerUriHandler).mockClear();
    vi.mocked(vscode.window.showInputBox).mockReset();
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    vi.mocked(vscode.window.showErrorMessage).mockReset();
  });

  function setupHandler() {
    const session = makeSession({ isUnlocked: false, resetSyncAfterLoss: vi.fn(async () => 'CODE-H') });
    const auth = { isLoggedIn: () => true, refreshEntitlement: vi.fn(async () => {}) } as any;
    const factory = { ensureSession: vi.fn(async () => session) };
    const context = { subscriptions: { push: vi.fn() } } as unknown as vscode.ExtensionContext;
    registerSyncResetUriHandler(context, auth, factory as any);
    const handler = vi.mocked(vscode.window.registerUriHandler).mock.calls[0][0];
    return { session, factory, handler };
  }

  it('非 /reset-after-loss 路径静默忽略（不建 session、不报错）', async () => {
    const { factory, handler } = setupHandler();
    await handler.handleUri({ path: '/other', query: `handoffTicket=${'A'.repeat(43)}` } as unknown as vscode.Uri);
    expect(factory.ensureSession).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('缺 ticket → 显示 resetHandoffInvalid，不建 session', async () => {
    const { factory, handler } = setupHandler();
    await handler.handleUri({ path: '/reset-after-loss', query: '' } as unknown as vscode.Uri);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(factory.ensureSession).not.toHaveBeenCalled();
  });

  it('畸形 ticket → 快速拒绝，不进入 SMP 输入、不建 session', async () => {
    const { session, factory, handler } = setupHandler();
    await handler.handleUri({ path: '/reset-after-loss', query: 'handoffTicket=short' } as unknown as vscode.Uri);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(factory.ensureSession).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(session.resetSyncAfterLoss).not.toHaveBeenCalled();
  });

  it('合法 ticket → 日志仅 handoff:<8hex> 脱敏前缀，进入 SMP 流程', async () => {
    const { session, factory, handler } = setupHandler();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined); // 用户取消 SMP
    const ticket = 'A'.repeat(43);
    await handler.handleUri({ path: '/reset-after-loss', query: `handoffTicket=${ticket}` } as unknown as vscode.Uri);
    expect(factory.ensureSession).toHaveBeenCalled();
    expect(vscode.window.showInputBox).toHaveBeenCalled();
    expect(session.resetSyncAfterLoss).not.toHaveBeenCalled(); // 取消 SMP，未消费 ticket
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).toContain('handoff:');
    expect(logged).not.toContain(ticket);
    logSpy.mockRestore();
  });
});
