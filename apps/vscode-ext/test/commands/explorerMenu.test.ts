import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
}));

import { buildExplorerMenu, EXPLORER_MENU_COMMANDS } from '../../src/commands/explorerMenu';

const values = (loggedIn: boolean, unlocked: boolean, autoOn = false): (string | undefined)[] =>
  buildExplorerMenu({ loggedIn, unlocked, autoOn }).filter((i) => !i.separator).map((i) => i.value);

describe('explorerMenu builder', () => {
  it('未登录：连接段 + 登录，无同步/账户项', () => {
    const v = values(false, false);
    expect(v).toContain('addGroup');
    expect(v).toContain('refresh');
    expect(v).toContain('searchConnections');
    expect(v).toContain('login');
    expect(v).not.toContain('syncEntry');
    expect(v).not.toContain('syncNow');
    expect(v).not.toContain('account');
  });

  it('已登录未解锁：同步项=解锁/初始化→syncEntry；无拉取/推送/自动同步', () => {
    const v = values(true, false);
    expect(v).toContain('syncEntry');
    expect(v).not.toContain('syncNow');
    expect(v).not.toContain('syncPull');
    expect(v).not.toContain('syncPush');
    expect(v).not.toContain('toggleAutoSync');
    expect(v).toContain('account');
  });

  it('已登录已解锁：同步项=立即同步→syncNow；含拉取/推送/自动同步，无 syncEntry', () => {
    const v = values(true, true);
    expect(v).toContain('syncNow');
    expect(v).not.toContain('syncEntry');
    expect(v).toContain('syncPull');
    expect(v).toContain('syncPush');
    expect(v).toContain('toggleAutoSync');
  });

  it('分隔线分段：连接 / 同步 / 账户', () => {
    const separators = buildExplorerMenu({ loggedIn: true, unlocked: true, autoOn: false })
      .filter((i) => i.separator).map((i) => i.label);
    expect(separators).toHaveLength(3);
  });

  it('value→命令 id 映射正确（syncEntry/syncNow 不再共用）', () => {
    expect(EXPLORER_MENU_COMMANDS.syncEntry).toBe('devbelt.syncEntry');
    expect(EXPLORER_MENU_COMMANDS.syncNow).toBe('devbelt.syncNow');
    expect(EXPLORER_MENU_COMMANDS.account).toBe('devbelt.account');
    expect(EXPLORER_MENU_COMMANDS.refresh).toBe('devbelt.refresh');
    expect(EXPLORER_MENU_COMMANDS.searchConnections).toBe('devbelt.searchConnections');
  });
});