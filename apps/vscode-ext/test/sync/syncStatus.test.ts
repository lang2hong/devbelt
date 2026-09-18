import { describe, expect, it } from 'vitest';
import { deriveSyncStatus } from '@devkit/db-host/sync/syncStatus';
import type { SyncRunResult } from '@devkit/db-host/sync/e2e/syncEngine';

function run(stage: SyncRunResult['stage']): SyncRunResult {
  return { stage, conflicts: [], applied: 0 };
}

describe('deriveSyncStatus', () => {
  it('未解锁 → hidden', () => {
    expect(deriveSyncStatus({ isUnlocked: false, stalled: false, retrying: false })).toBe('hidden');
  });

  it('stalled → stalled（优先于 error）', () => {
    expect(deriveSyncStatus({
      isUnlocked: true, stalled: true, retrying: false, lastError: 'x', lastRun: run('error'),
    })).toBe('stalled');
  });

  it('无错误 → idle', () => {
    expect(deriveSyncStatus({ isUnlocked: true, stalled: false, retrying: false, lastRun: run('ok') })).toBe('idle');
    expect(deriveSyncStatus({ isUnlocked: true, stalled: false, retrying: false })).toBe('idle');
  });

  it('stage=error 且退避中 → retrying', () => {
    expect(deriveSyncStatus({
      isUnlocked: true, stalled: false, retrying: true, lastRun: run('error'),
    })).toBe('retrying');
  });

  it('stage=error → error（绝不为 idle）', () => {
    expect(deriveSyncStatus({ isUnlocked: true, stalled: false, retrying: false, lastRun: run('error') })).toBe('error');
  });

  it('lastError 存在 → error', () => {
    expect(deriveSyncStatus({
      isUnlocked: true, stalled: false, retrying: false, lastError: 'network down',
    })).toBe('error');
  });

  it('有未解决冲突 → conflict（优先于 stalled/error）', () => {
    expect(deriveSyncStatus({
      isUnlocked: true, stalled: true, retrying: false, lastError: 'x', lastRun: run('error'), conflictCount: 1,
    })).toBe('conflict');
    expect(deriveSyncStatus({ isUnlocked: true, stalled: false, retrying: false, conflictCount: 3 })).toBe('conflict');
  });

  it('无冲突（conflictCount 0/缺省）不影响既有判定', () => {
    expect(deriveSyncStatus({ isUnlocked: true, stalled: false, retrying: false, conflictCount: 0 })).toBe('idle');
  });
});