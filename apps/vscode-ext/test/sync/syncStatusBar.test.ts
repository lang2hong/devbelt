import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  item: { command: '', text: '', tooltip: '' as string, show: vi.fn(), hide: vi.fn(), dispose: vi.fn() },
}));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
  StatusBarAlignment: { Left: 1 },
  window: { createStatusBarItem: () => h.item },
  commands: { executeCommand: vi.fn(async () => undefined) },
}));

import { createSyncStatusBar, type SyncStatusSession } from '../../src/sync/syncStatusBar';

function session(over: Partial<SyncStatusSession> = {}): SyncStatusSession {
  return {
    isUnlocked: true,
    stalled: false,
    retrying: false,
    epochStale: false,
    listConflicts: () => [],
    ...over,
  };
}

function bar(s: SyncStatusSession | undefined) {
  const bar = createSyncStatusBar({ subscriptions: [] } as never, { isLoggedIn: () => true } as never, () => s, () => false);
  bar.refresh();
  return bar;
}

beforeEach(() => { h.item.tooltip = ''; h.item.text = ''; h.item.command = ''; });

describe('同步状态栏 tooltip', () => {
  it('error：显示本地化原因，不泄漏原始英文 reason，并指向日志', () => {
    bar(session({ lastRun: { stage: 'error', conflicts: [], applied: 0, reason: 'getState failed: fetch failed' } }));
    expect(h.item.text).toContain('$(error)');
    expect(h.item.tooltip).toContain('network');
    expect(h.item.tooltip).not.toContain('getState failed');
    expect(h.item.tooltip).toContain('Diagnostics Log');
  });

  it('stalled：不再只有固定文案，带上 terminal 对应的原因（配额）', () => {
    bar(session({
      stalled: true,
      lastRun: { stage: 'terminal', conflicts: [], applied: 0, terminal: { code: 'SYNC_QUOTA_EXCEEDED' }, reason: 'push rejected: quota exceeded' },
    }));
    expect(h.item.text).toContain('$(warning)');
    expect(h.item.tooltip).toContain('paused');
    expect(h.item.tooltip).toContain('quota is full');
    expect(h.item.tooltip).not.toContain('push rejected');
  });

  it('stalled 且没有可归因的原因：仍指向日志入口', () => {
    bar(session({ stalled: true, lastRun: { stage: 'epoch-mismatch', conflicts: [], applied: 0 } as never }));
    // epochStale=false 时走通用 stalled 分支
    expect(h.item.tooltip).toContain('Diagnostics Log');
  });

  it('epochStale 仍路由到解锁命令', () => {
    bar(session({ stalled: true, epochStale: true }));
    expect(h.item.command).toBe('devbelt.unlockPersonalSync');
  });

  it('idle 不带错误信息', () => {
    bar(session({ lastRun: { stage: 'ok', conflicts: [], applied: 0 } }));
    expect(h.item.text).toContain('$(sync)');
    expect(h.item.tooltip).not.toContain('Diagnostics Log');
  });
});
