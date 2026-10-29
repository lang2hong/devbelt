import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
}));

import { SyncFailureNotifier } from '../../src/sync/syncFailureNotifier';

function make(picked?: string) {
  const warn = vi.fn(async () => picked);
  const run = vi.fn();
  return { notifier: new SyncFailureNotifier({ warn, run }), warn, run };
}

const err = { stage: 'error', reason: 'getState failed: fetch failed' };

describe('SyncFailureNotifier', () => {
  it('可重试的 error：连续 3 轮才提醒，前两轮静默', () => {
    const { notifier, warn } = make();
    notifier.onResult(err);
    notifier.onResult(err);
    expect(warn).not.toHaveBeenCalled();
    notifier.onResult(err);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('同一类失败只提醒一次，之后的失败不重复弹', () => {
    const { notifier, warn } = make();
    for (let i = 0; i < 10; i++) notifier.onResult(err);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('一次成功就清零连续计数并重置「已提醒」', () => {
    const { notifier, warn } = make();
    notifier.onResult(err);
    notifier.onResult(err);
    notifier.onResult({ stage: 'ok' });
    notifier.onResult(err);
    notifier.onResult(err);
    expect(warn).not.toHaveBeenCalled();
    notifier.onResult(err);
    expect(warn).toHaveBeenCalledTimes(1);
    notifier.onResult({ stage: 'ok' });
    for (let i = 0; i < 3; i++) notifier.onResult(err);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('terminal 立即提醒（不等 3 轮），并带本地化原因而非原始英文', () => {
    const { notifier, warn } = make();
    notifier.onResult({ stage: 'terminal', terminal: { code: 'SYNC_QUOTA_EXCEEDED' }, reason: 'push rejected: quota exceeded' });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as unknown as [string, ...string[]];
    expect(message).toContain('quota is full');
    expect(message).not.toContain('push rejected');
  });

  it('不同类的 terminal 各自提醒一次', () => {
    const { notifier, warn } = make();
    notifier.onResult({ stage: 'terminal', terminal: { code: 'SYNC_QUOTA_EXCEEDED' } });
    notifier.onResult({ stage: 'terminal', terminal: { code: 'SYNC_QUOTA_EXCEEDED' } });
    notifier.onResult({ stage: 'terminal', terminal: { code: 'SYNC_SIGNATURE_INVALID' } });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('冲突不弹（由状态栏与体检面板引导）', () => {
    const { notifier, warn } = make();
    for (let i = 0; i < 5; i++) notifier.onResult({ stage: 'conflict' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('协调器抛异常（无 result）按可重试失败计', () => {
    const { notifier, warn } = make();
    notifier.onResult(undefined, 'fetch failed');
    notifier.onResult(undefined, 'fetch failed');
    expect(warn).not.toHaveBeenCalled();
    notifier.onResult(undefined, 'fetch failed');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('手动同步进行期间不弹（手动同步自己会反馈结果）', () => {
    const { notifier, warn } = make();
    notifier.beginManual();
    notifier.onResult({ stage: 'terminal', terminal: { code: 'SYNC_QUOTA_EXCEEDED' } });
    notifier.endManual();
    expect(warn).not.toHaveBeenCalled();
  });

  it('点击按钮会执行对应命令', async () => {
    const { notifier, run } = make('View Logs');
    notifier.onResult({ stage: 'terminal', terminal: { code: 'SYNC_QUOTA_EXCEEDED' } });
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('devbelt.showDiagnostics'));
  });

  it('未点按钮（关闭通知）不执行任何命令', async () => {
    const { notifier, warn, run } = make(undefined);
    notifier.onResult({ stage: 'terminal', terminal: { code: 'SYNC_QUOTA_EXCEEDED' } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it('登录过期的按钮指向重新登录', async () => {
    const { notifier, run } = make('Sign In Again');
    notifier.onResult({ stage: 'terminal', reason: 'authentication expired' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('devbelt.login'));
  });
});
