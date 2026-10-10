import { describe, expect, it } from 'vitest';
import { parseEsError } from '../../src/elasticsearch/esError';

describe('parseEsError（ES 错误结构化）', () => {
  it('标准形态：type/reason/root_cause', () => {
    const info = parseEsError({
      error: {
        type: 'search_phase_execution_exception',
        reason: 'all shards failed',
        root_cause: [{ type: 'query_shard_exception', reason: 'failed to parse', index: 'idx-1' }],
      },
    });
    expect(info?.type).toBe('search_phase_execution_exception');
    expect(info?.reason).toBe('all shards failed');
    expect(info?.rootCause).toEqual([{ type: 'query_shard_exception', reason: 'failed to parse', index: 'idx-1' }]);
  });

  it('字符串 error（网关/反代）', () => {
    expect(parseEsError({ error: 'Forbidden' })).toEqual({ reason: 'Forbidden', rootCause: [] });
  });

  it('caused_by 链并入 reason（≤3 层）', () => {
    const info = parseEsError({
      error: { type: 'x', caused_by: { reason: 'inner', caused_by: { reason: 'root' } } },
    });
    expect(info?.reason).toBe('inner ← root');
  });

  it('无 error / 非对象安全返回', () => {
    expect(parseEsError({ acknowledged: true })).toBeUndefined();
    expect(parseEsError('boom')).toBeUndefined();
    expect(parseEsError(null)).toBeUndefined();
    expect(parseEsError({ error: 42 })).toBeUndefined();
  });
});