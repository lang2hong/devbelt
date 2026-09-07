import { describe, expect, it, vi } from 'vitest';

const { windowMock, commandHandlers } = vi.hoisted(() => {
  const windowMock = {
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  };
  const commandHandlers = new Map<string, () => void | Promise<void>>();
  return { windowMock, commandHandlers };
});

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
  window: windowMock,
  commands: {
    registerCommand: (id: string, fn: () => void | Promise<void>) => {
      commandHandlers.set(id, fn);
      return { dispose() {} };
    },
  },
}));

import { registerConflictCommands } from '../../src/commands/syncConflicts';
import type { SyncSessionFactory } from '../../src/sync/sessionFactory';
import type { ConflictItem } from '../../src/sync/e2e/conflictResolver';

interface Session {
  isUnlocked?: boolean;
  listConflicts: () => ConflictItem[];
  resolveConflict: (recordId: string, decision: 'local' | 'remote' | 'cancel') => Promise<void>;
  scheduleNow: () => void;
}

function makeSession(over: Partial<Session> = {}): Session {
  return {
    isUnlocked: true,
    listConflicts: () => [conflict('A'.repeat(22), 'connection', 'c-1', 'version')],
    resolveConflict: vi.fn(async () => {}),
    scheduleNow: vi.fn(),
    ...over,
  };
}

function conflict(recordId: string, type: 'connection' | 'group' | 'queryFolder' | 'query', localId: string, kind: 'version' | 'pending'): ConflictItem {
  return { recordId, type, localId, kind, remoteVersion: '2' };
}

function register(session: Session): () => Promise<void> {
  commandHandlers.clear();
  windowMock.showQuickPick.mockReset();
  windowMock.showInformationMessage.mockReset();
  windowMock.showWarningMessage.mockReset();
  registerConflictCommands({ subscriptions: [] } as never, { current: session } as never as SyncSessionFactory);
  const handler = commandHandlers.get('dbclient.resolveConflicts');
  if (!handler) throw new Error('resolveConflicts handler not registered');
  return () => Promise.resolve(handler());
}

describe('syncConflicts 命令（B4 冲突面板）', () => {
  it('无冲突 → 提示、不弹 QuickPick', async () => {
    const session = makeSession({ listConflicts: () => [] });
    const run = register(session);
    await run();
    expect(windowMock.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(windowMock.showQuickPick).not.toHaveBeenCalled();
  });

  it('单条 Cancel → 不 resolve、不 scheduleNow', async () => {
    const session = makeSession();
    const run = register(session);
    windowMock.showQuickPick.mockResolvedValueOnce({ label: 'connection:c-1', recordId: 'A'.repeat(22) });
    windowMock.showQuickPick.mockResolvedValueOnce({ value: 'cancel' });
    await run();
    expect(session.resolveConflict).not.toHaveBeenCalled();
    expect(session.scheduleNow).not.toHaveBeenCalled();
  });

  it('单条 Use Local → resolveConflict(local) + scheduleNow', async () => {
    const session = makeSession();
    const run = register(session);
    windowMock.showQuickPick.mockResolvedValueOnce({ label: 'connection:c-1', recordId: 'A'.repeat(22) });
    windowMock.showQuickPick.mockResolvedValueOnce({ value: 'local' });
    await run();
    expect(session.resolveConflict).toHaveBeenCalledWith('A'.repeat(22), 'local');
    expect(session.scheduleNow).toHaveBeenCalledTimes(1);
  });

  it('单条 Use Remote → resolveConflict(remote) + scheduleNow', async () => {
    const session = makeSession();
    const run = register(session);
    windowMock.showQuickPick.mockResolvedValueOnce({ label: 'connection:c-1', recordId: 'A'.repeat(22) });
    windowMock.showQuickPick.mockResolvedValueOnce({ value: 'remote' });
    await run();
    expect(session.resolveConflict).toHaveBeenCalledWith('A'.repeat(22), 'remote');
    expect(session.scheduleNow).toHaveBeenCalledTimes(1);
  });

  it('单条 Use Remote 失败（远端数据未就绪）→ 提示 + 仍 scheduleNow', async () => {
    const session = makeSession({
      resolveConflict: vi.fn(async () => { throw new Error('remote version not yet fetched'); }),
    });
    const run = register(session);
    windowMock.showQuickPick.mockResolvedValueOnce({ label: 'connection:c-1', recordId: 'A'.repeat(22) });
    windowMock.showQuickPick.mockResolvedValueOnce({ value: 'remote' });
    await run();
    expect(windowMock.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(session.scheduleNow).toHaveBeenCalledTimes(1);
  });

  it('批量决策：单条失败不阻断其余，最终 scheduleNow 一次', async () => {
    const items = [
      conflict('A'.repeat(22), 'connection', 'c-1', 'version'),
      conflict('B'.repeat(22), 'connection', 'c-2', 'version'),
      conflict('C'.repeat(22), 'connection', 'c-3', 'version'),
    ];
    const resolveConflict = vi.fn(async (recordId: string) => {
      if (recordId === 'B'.repeat(22)) throw new Error('boom');
    });
    const session = makeSession({ listConflicts: () => items, resolveConflict });
    const run = register(session);
    windowMock.showQuickPick.mockResolvedValueOnce({ bulk: 'local' });
    await run();
    expect(resolveConflict).toHaveBeenCalledTimes(3);
    expect(resolveConflict).toHaveBeenNthCalledWith(1, 'A'.repeat(22), 'local');
    expect(resolveConflict).toHaveBeenNthCalledWith(3, 'C'.repeat(22), 'local');
    expect(session.scheduleNow).toHaveBeenCalledTimes(1);
  });
});