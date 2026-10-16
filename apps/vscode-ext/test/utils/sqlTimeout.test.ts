import { describe, expect, it } from 'vitest';
import { QueryService } from '@devbelt/db-core';
import {
  DEFAULT_QUERY_TIMEOUT_SECONDS,
  MAX_QUERY_TIMEOUT_SECONDS,
  applyQueryTimeoutFromConfig,
  resolveQueryTimeoutMs,
} from '../../src/utils/sqlTimeout';

describe('resolveQueryTimeoutMs（设置值 → 毫秒）', () => {
  it('默认 300 秒；数值直通', () => {
    expect(resolveQueryTimeoutMs(undefined)).toBe(300_000);
    expect(resolveQueryTimeoutMs(300)).toBe(300_000);
    expect(resolveQueryTimeoutMs(60)).toBe(60_000);
  });
  it('0 = 不超时；非法回退默认；越界钳制', () => {
    expect(resolveQueryTimeoutMs(0)).toBe(0);
    expect(resolveQueryTimeoutMs('x' as never)).toBe(300_000);
    expect(resolveQueryTimeoutMs(Number.NaN)).toBe(300_000);
    expect(resolveQueryTimeoutMs(-5)).toBe(0);
    expect(resolveQueryTimeoutMs(99_999)).toBe(MAX_QUERY_TIMEOUT_SECONDS * 1000);
    expect(resolveQueryTimeoutMs(1.9)).toBe(1000);
  });
});

describe('applyQueryTimeoutFromConfig（静态默认装配）', () => {
  it('写入 QueryService.queryTimeout；缺省用默认', () => {
    const old = QueryService.queryTimeout;
    try {
      applyQueryTimeoutFromConfig(() => undefined);
      expect(QueryService.queryTimeout).toBe(DEFAULT_QUERY_TIMEOUT_SECONDS * 1000);
      applyQueryTimeoutFromConfig(() => 120);
      expect(QueryService.queryTimeout).toBe(120_000);
    } finally {
      QueryService.queryTimeout = old;
    }
  });
});
