import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
  window: {},
  commands: {},
}));

import {
  changeSyncPassword,
  recoverSync,
  destroySync,
  resetSync,
  type SyncLifecycleCommandDeps,
} from '../../src/commands/syncLifecycle';

function makeSession(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    isUnlocked: false,
    pendingCleanup: undefined,
    changeSyncPassword: vi.fn(async () => {}),
    recoverSync: vi.fn(async () => 'NEWCODE'),
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

  it('resetSync：challenge → token → 新口令 → 成功', async () => {
    const session = makeSession({ isUnlocked: false, resetSyncAfterLoss: vi.fn(async () => 'CODE-RS') });
    const { deps, ui } = makeDeps(session);
    ui.confirmIrreversible.mockResolvedValue(true);
    ui.promptText.mockResolvedValue('token');
    ui.promptSmp.mockResolvedValueOnce('new-passphrase-123').mockResolvedValueOnce('new-passphrase-123');
    await resetSync(deps);
    expect(session.requestResetChallenge).toHaveBeenCalled();
    expect(session.resetSyncAfterLoss).toHaveBeenCalledWith('token', 'new-passphrase-123');
    expect(ui.confirmRecoveryCode).toHaveBeenCalledWith('CODE-RS');
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