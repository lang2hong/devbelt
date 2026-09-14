import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const commandHandlers = new Map<string, (...a: any[]) => any>();
  return {
    commandHandlers,
    window: {
      showInputBox: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    env: { language: 'en', openExternal: vi.fn(async () => true) },
    commands: {
      registerCommand: vi.fn((cmd: string, h: any) => { commandHandlers.set(cmd, h); return { dispose() {} }; }),
      executeCommand: vi.fn(async () => {}),
    },
    Uri: { parse: (s: string) => ({ toString: () => s, fsPath: s }), file: (p: string) => ({ fsPath: p }) },
  };
});

vi.mock('vscode', () => ({
  window: mocks.window,
  env: mocks.env,
  commands: mocks.commands,
  Uri: mocks.Uri,
  workspace: { getConfiguration: () => ({ get: (_k: string, d: any) => d }) },
}));

import { registerAccountCommands, changeLoginPassword } from '../../src/commands/account';

function makeDeps(over: { loggedIn?: boolean; changePassword?: any; logout?: any } = {}) {
  const auth = {
    isLoggedIn: () => over.loggedIn !== false,
    changePassword: over.changePassword ?? vi.fn(async () => {}),
    logout: over.logout ?? vi.fn(async () => {}),
  };
  const syncFactory = { current: undefined, ensureSession: vi.fn(async () => undefined) };
  return { auth, syncFactory } as any;
}

function register(deps: any) {
  const handlers = new Map<string, (...a: any[]) => any>();
  registerAccountCommands(deps, (cmd, h) => handlers.set(cmd, h));
  return handlers;
}

beforeEach(() => {
  mocks.window.showInputBox.mockReset();
  mocks.window.showWarningMessage.mockReset();
  mocks.window.showInformationMessage.mockReset();
  mocks.window.showErrorMessage.mockReset();
  mocks.env.openExternal.mockClear();
});

describe('account commands', () => {
  it('openConsole opens the current user console page', async () => {
    const handlers = register(makeDeps());
    await handlers.get('dbclient.openConsole')!();
    expect(mocks.env.openExternal).toHaveBeenCalledTimes(1);
    const url = String((mocks.env.openExternal as any).mock.calls[0][0]);
    expect(url).toContain('/console/account');
  });

  it('changeLoginPassword: success logs out and prompts re-login', async () => {
    const changePassword = vi.fn(async () => {});
    const logout = vi.fn(async () => {});
    mocks.window.showInputBox
      .mockResolvedValueOnce('old-pass-1')
      .mockResolvedValueOnce('new-pass-123')
      .mockResolvedValueOnce('new-pass-123');
    const deps = makeDeps({ changePassword, logout });

    await changeLoginPassword(deps);

    expect(changePassword).toHaveBeenCalledWith('old-pass-1', 'new-pass-123');
    expect(logout).toHaveBeenCalledTimes(1);
    expect(mocks.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('changeLoginPassword: mismatch does not call the API', async () => {
    const changePassword = vi.fn(async () => {});
    mocks.window.showInputBox
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce('new-pass-123')
      .mockResolvedValueOnce('different-123');
    const deps = makeDeps({ changePassword });

    await changeLoginPassword(deps);

    expect(changePassword).not.toHaveBeenCalled();
    expect(mocks.window.showErrorMessage).toHaveBeenCalledTimes(1);
  });

  it('changeLoginPassword: too-short new password is rejected', async () => {
    const changePassword = vi.fn(async () => {});
    mocks.window.showInputBox.mockResolvedValueOnce('old').mockResolvedValueOnce('short');
    const deps = makeDeps({ changePassword });

    await changeLoginPassword(deps);

    expect(changePassword).not.toHaveBeenCalled();
    expect(mocks.window.showErrorMessage).toHaveBeenCalledTimes(1);
  });

  it('changeLoginPassword: requires login', async () => {
    const deps = makeDeps({ loggedIn: false });
    await changeLoginPassword(deps);
    expect(mocks.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(mocks.window.showInputBox).not.toHaveBeenCalled();
  });

  it('changeLoginPassword: API failure shows error and does not log out', async () => {
    const logout = vi.fn(async () => {});
    const changePassword = vi.fn(async () => { throw new Error('bad current password'); });
    mocks.window.showInputBox
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce('new-pass-123')
      .mockResolvedValueOnce('new-pass-123');
    const deps = makeDeps({ changePassword, logout });

    await changeLoginPassword(deps);

    expect(logout).not.toHaveBeenCalled();
    expect(mocks.window.showErrorMessage).toHaveBeenCalledTimes(1);
  });
});