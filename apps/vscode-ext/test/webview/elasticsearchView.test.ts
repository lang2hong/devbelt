import { describe, expect, it } from 'vitest';
import { createLatestRequestTracker, formatPercent, pushDslHistory } from '../../webview/src/components/elasticsearch/types';

describe('createLatestRequestTracker（ES 异步响应代际）', () => {
  it('只接受最新请求的响应', () => {
    const tracker = createLatestRequestTracker();
    tracker.begin('r1');
    expect(tracker.isCurrent('r1')).toBe(true);
    expect(tracker.isCurrent('r0')).toBe(false);

    tracker.begin('r2');
    expect(tracker.isCurrent('r1')).toBe(false);
    expect(tracker.isCurrent('r2')).toBe(true);
  });

  it('clear 后旧响应失效', () => {
    const tracker = createLatestRequestTracker();
    tracker.begin('r1');
    tracker.clear();
    expect(tracker.isCurrent('r1')).toBe(false);
    expect(tracker.isCurrent(undefined)).toBe(false);
  });
});

describe('formatPercent（节点百分比）', () => {
  it('缺失值显示 —，不显示 —%', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatPercent(42)).toBe('42%');
  });
});

describe('pushDslHistory（DSL 历史索引）', () => {
  it('新记录置顶，保留索引并限制条数', () => {
    const first = { index: 'a', body: '{"size":1}', at: 1 };
    const second = { index: 'b', body: '{"size":2}', at: 2 };
    const third = { index: 'c', body: '{"size":3}', at: 3 };
    const out = pushDslHistory(pushDslHistory(pushDslHistory([], first, 2), second, 2), third, 2);
    expect(out.map((h) => h.index)).toEqual(['c', 'b']);
    expect(out[0].body).toBe('{"size":3}');
  });
});