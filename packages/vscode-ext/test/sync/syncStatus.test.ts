import { describe, expect, it } from 'vitest';
import { deriveSyncStatus } from '../../src/sync/syncStatus';
import type { SyncRunResult } from '../../src/sync/e2e/syncEngine';

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
});