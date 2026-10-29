import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
}));

import {
  classifySyncFailure,
  describeSyncFailure,
  errorDetail,
  failureInputOf,
  looksLikeNetworkError,
} from '../../src/sync/syncFailure';

describe('classifySyncFailure', () => {
  it.each([
    [{ terminalCode: 'SYNC_QUOTA_EXCEEDED' }, 'quota'],
    [{ terminalCode: 'SYNC_SIGNATURE_INVALID' }, 'signature'],
    [{ terminalCode: 'PERSONAL_FEATURE_REQUIRED' }, 'featureRequired'],
    [{ terminalCode: 'SYNC_PROTOCOL_UNSUPPORTED' }, 'protocol'],
    [{ terminalCode: 'SYNC_EPOCH_STALE' }, 'epoch'],
    [{ terminalCode: 'SYNC_NOT_INITIALIZED' }, 'notInitialized'],
  ])('终态码 %j → %s', (input, kind) => {
    expect(classifySyncFailure(input)).toBe(kind);
  });

  it('终态码优先于 reason 文本', () => {
    expect(classifySyncFailure({ terminalCode: 'SYNC_QUOTA_EXCEEDED', reason: 'fetch failed' })).toBe('quota');
  });

  it.each([
    [{ reason: 'authentication expired' }, 'auth'],
    [{ reason: 'push rejected: quota exceeded' }, 'quota'],
    [{ reason: 'feed protocol unsupported: bad page' }, 'protocol'],
    [{ reason: 'getState failed: fetch failed' }, 'network'],
    [{ reason: 'pull failed: connect ECONNREFUSED 1.2.3.4:443' }, 'network'],
    [{ reason: 'getState failed: ETIMEDOUT' }, 'network'],
    [{ stage: 'epoch-mismatch' }, 'epoch'],
    [{ reason: 'remote keyEpoch differs from local' }, 'epoch'],
    [{ reason: 'cursor commit failed: disk full' }, 'other'],
    [{}, 'other'],
  ])('reason %j → %s', (input, kind) => {
    expect(classifySyncFailure(input)).toBe(kind);
  });
});

describe('describeSyncFailure', () => {
  it('返回本地化说明，而不是原始英文 reason', () => {
    const text = describeSyncFailure({ reason: 'getState failed: fetch failed' });
    expect(text).toContain('network');
    expect(text).not.toContain('getState failed');
  });

  it('未知原因给出指向日志的通用说明', () => {
    expect(describeSyncFailure({ reason: 'weird internal thing' })).toContain('View Logs');
  });

  it('配额说明强调其他数据仍会同步', () => {
    expect(describeSyncFailure({ terminalCode: 'SYNC_QUOTA_EXCEEDED' })).toContain('everything else still syncs');
  });
});

describe('failureInputOf', () => {
  it('取 terminal.code 与 reason，reason 缺失时用 lastError', () => {
    expect(failureInputOf({ stage: 'terminal', terminal: { code: 'SYNC_QUOTA_EXCEEDED' }, reason: 'r' }, 'e'))
      .toEqual({ stage: 'terminal', terminalCode: 'SYNC_QUOTA_EXCEEDED', reason: 'r' });
    expect(failureInputOf(undefined, 'boom')).toEqual({ stage: undefined, terminalCode: undefined, reason: 'boom' });
  });
});

describe('looksLikeNetworkError', () => {
  it('识别常见网络层故障，业务错误不算', () => {
    expect(looksLikeNetworkError('fetch failed')).toBe(true);
    expect(looksLikeNetworkError(undefined, 'ECONNRESET')).toBe(true);
    expect(looksLikeNetworkError('Invalid email or password')).toBe(false);
  });
});

describe('errorDetail', () => {
  it('记录错误名、状态码、错误码与消息', () => {
    const err = Object.assign(new Error('Request failed: 500'), { name: 'SyncApiError', status: 500, code: 'X' });
    expect(errorDetail(err)).toEqual({ name: 'SyncApiError', status: 500, code: 'X', message: 'Request failed: 500' });
  });

  it('includeMessage=false 时不带消息（用于可能含 ticket 的场景）', () => {
    const detail = errorDetail(new Error('ticket abc123'), false);
    expect(detail).not.toHaveProperty('message');
    expect(JSON.stringify(detail)).not.toContain('abc123');
  });

  it('超长消息被截断', () => {
    const detail = errorDetail(new Error('x'.repeat(1000)));
    expect(String(detail.message).length).toBeLessThanOrEqual(301);
  });

  it('非 Error 值不抛', () => {
    expect(() => errorDetail('plain string')).not.toThrow();
    expect(() => errorDetail(undefined)).not.toThrow();
  });
});
