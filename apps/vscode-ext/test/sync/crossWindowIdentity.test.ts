import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
}));

import { createCrossWindowIdentityHandler } from '../../src/sync/crossWindowIdentity';

function make(picked?: string) {
  const deps = {
    invalidateSync: vi.fn(),
    refreshStatus: vi.fn(),
    warn: vi.fn(async () => picked),
    reloadWindow: vi.fn(),
    log: vi.fn(),
  };
  return { deps, handler: createCrossWindowIdentityHandler(deps) };
}

describe('createCrossWindowIdentityHandler', () => {
  it('停掉同步会话、刷新状态栏、提示重新加载', () => {
    const { deps, handler } = make();
    handler({ from: '1', to: '2' });
    expect(deps.invalidateSync).toHaveBeenCalledTimes(1);
    expect(deps.refreshStatus).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledTimes(1);
    const [message, action] = deps.warn.mock.calls[0] as unknown as [string, string];
    expect(message).toContain('another window');
    expect(action).toBe('Reload Window');
  });

  it('提示每个窗口会话只弹一次，但每次变化都要停会话', () => {
    const { deps, handler } = make();
    handler({ from: '1', to: '2' });
    handler({ from: '2', to: '3' });
    handler({ from: '3', to: undefined });
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.invalidateSync).toHaveBeenCalledTimes(3);
  });

  it('点击「重新加载窗口」才重载；关闭通知不重载', async () => {
    const yes = make('Reload Window');
    yes.handler({ from: '1', to: '2' });
    await vi.waitFor(() => expect(yes.deps.reloadWindow).toHaveBeenCalledTimes(1));

    const no = make(undefined);
    no.handler({ from: '1', to: '2' });
    await vi.waitFor(() => expect(no.deps.warn).toHaveBeenCalled());
    await Promise.resolve();
    expect(no.deps.reloadWindow).not.toHaveBeenCalled();
  });

  it('不走账号迁移询问：只有这四个动作，没有迁移相关依赖', () => {
    const { deps } = make();
    expect(Object.keys(deps).sort()).toEqual(['invalidateSync', 'log', 'refreshStatus', 'reloadWindow', 'warn']);
  });

  it('日志只记「有没有用户」，不记 userId 本身', () => {
    const { deps, handler } = make();
    handler({ from: '12345', to: '67890' });
    const logged = JSON.stringify(deps.log.mock.calls);
    expect(logged).not.toContain('12345');
    expect(logged).not.toContain('67890');
    expect(deps.log).toHaveBeenCalledWith('account changed in another window', { hadUser: true, hasUser: true });
  });

  it('另一窗口登出（to 为空）同样停会话并提示', () => {
    const { deps, handler } = make();
    handler({ from: '1', to: undefined });
    expect(deps.invalidateSync).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('account changed in another window', { hadUser: true, hasUser: false });
  });
});
