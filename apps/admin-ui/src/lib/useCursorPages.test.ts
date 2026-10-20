import { describe, expect, it } from 'vitest';
import { useCursorPages } from './useCursorPages';

describe('useCursorPages', () => {
  it('下一页压入 cursor，上一页回到旧 cursor', () => {
    const p = useCursorPages(20);
    p.apply({ nextCursor: 'c2', total: 42 });
    expect(p.hasNext.value).toBe(true);
    expect(p.total.value).toBe(42);

    expect(p.next()).toBe(true);
    expect(p.page.value).toBe(2);
    expect(p.cursor.value).toBe('c2');

    p.apply({ nextCursor: 'c3' });
    expect(p.next()).toBe(true);
    expect(p.page.value).toBe(3);
    expect(p.cursor.value).toBe('c3');

    expect(p.prev()).toBe(true);
    expect(p.page.value).toBe(2);
    expect(p.cursor.value).toBe('c2');
    expect(p.total.value).toBe(42);
  });

  it('重置回到第一页；改每页条数也重置', () => {
    const p = useCursorPages(20);
    p.apply({ nextCursor: 'c2', total: 10 });
    p.next();
    p.reset();
    expect(p.page.value).toBe(1);
    expect(p.cursor.value).toBeUndefined();
    expect(p.hasNext.value).toBe(false);
    expect(p.total.value).toBeNull();

    p.setPageSize(50);
    expect(p.pageSize.value).toBe(50);
    expect(p.page.value).toBe(1);
  });
});