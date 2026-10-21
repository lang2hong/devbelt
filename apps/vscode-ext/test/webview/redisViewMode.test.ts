import { describe, expect, it } from 'vitest';
import { appendCollectionPage, computeStreamDone, isKeyBrowserPanel, matchesTextFilter } from '../../webview/src/components/redis/types';

describe('isKeyBrowserPanel（RedisView 键浏览器 vs 单栏面板）', () => {
  it('仅 keyBrowser → true', () => {
    expect(isKeyBrowserPanel('keyBrowser')).toBe(true);
  });

  it('其余面板 → false', () => {
    for (const p of ['serverStatus', 'console', 'slowlog', 'commandLog'] as const) {
      expect(isKeyBrowserPanel(p)).toBe(false);
    }
  });
});

describe('matchesTextFilter（集合本地过滤）', () => {
  it('空查询匹配全部，大小写不敏感', () => {
    expect(matchesTextFilter('Foo', '')).toBe(true);
    expect(matchesTextFilter('Foo Bar', '  ')).toBe(true);
    expect(matchesTextFilter('Foo Bar', 'foo')).toBe(true);
    expect(matchesTextFilter('Foo Bar', 'BAR')).toBe(true);
    expect(matchesTextFilter('Foo Bar', 'baz')).toBe(false);
  });
});

describe('computeStreamDone（Stream 续页判定）', () => {
  const stream = (n: number, len: number) => ({ kind: 'stream' as const, entries: Array.from({ length: n }, () => ({ id: '1-0', fields: [] as [string, string][] })), len, groups: [] });
  it('非 stream 恒 done', () => {
    expect(computeStreamDone(null)).toBe(true);
    expect(computeStreamDone({ kind: 'string', text: '' } as any)).toBe(true);
  });
  it('entries 未达 XLEN → 可续页；达到 → done', () => {
    expect(computeStreamDone(stream(100, 500))).toBe(false);
    expect(computeStreamDone(stream(100, 100))).toBe(true);
    expect(computeStreamDone(stream(3, 3))).toBe(true);
  });
});

describe('appendCollectionPage（R1：续页并行 base64 同序同长）', () => {
  it('hash：首屏无字节 + 续页二进制 → 旧项补占位、新项字节到位（hex/字节删除可用）', () => {
    const first: any = { kind: 'hash', entries: [['f1', 'v1']], len: 2 };
    const merged: any = appendCollectionPage(first, { kind: 'hash', entries: [['f2', '\uFFFD']], entryBytes: [['f2b', 'v2b']] });
    expect(merged.entries).toEqual([['f1', 'v1'], ['f2', '\uFFFD']]);
    expect(merged.entryBytes).toEqual([['', ''], ['f2b', 'v2b']]);
    // 对齐不变式：同长，且新项下标可取到精确字节（视图按 falsy 处理占位）。
    expect(merged.entryBytes).toHaveLength(merged.entries.length);
    expect(merged.entryBytes[1][0]).toBe('f2b');
  });

  it('hash：首屏有字节 + 续页全文本 → 新项补占位保持索引对齐', () => {
    const first: any = { kind: 'hash', entries: [['f1', '\uFFFD']], len: 2, entryBytes: [['f1b', 'v1b']] };
    const merged: any = appendCollectionPage(first, { kind: 'hash', entries: [['f2', 'v2']] });
    expect(merged.entryBytes).toEqual([['f1b', 'v1b'], ['', '']]);
    expect(merged.entryBytes[0][0]).toBe('f1b');
  });

  it('list/set：两侧都无字节 → 不建数组（行为与原一致）', () => {
    const list: any = appendCollectionPage({ kind: 'list', items: ['a'], len: 2 } as any, { kind: 'list', items: ['b'] });
    expect(list.items).toEqual(['a', 'b']);
    expect(list.itemBytes).toBeUndefined();
    const set: any = appendCollectionPage({ kind: 'set', members: ['a'], card: 2 } as any, { kind: 'set', members: ['b'] });
    expect(set.memberBytes).toBeUndefined();
  });

  it('list：续页二进制 → 追加精确字节并与文本对齐', () => {
    const merged: any = appendCollectionPage({ kind: 'list', items: ['a'], len: 2 } as any, { kind: 'list', items: ['\uFFFD'], itemBytes: ['bb'] });
    expect(merged.itemBytes).toEqual(['', 'bb']);
    expect(merged.itemBytes[1]).toBe('bb');
  });

  it('zset：占位为 [\'\', \'\'];续页二进制对到位', () => {
    const merged: any = appendCollectionPage(
      { kind: 'zset', items: [['m1', '1']], card: 2 } as any,
      { kind: 'zset', items: [['\uFFFD', '2']], itemBytes: [['mb', '2']] },
    );
    expect(merged.itemBytes).toEqual([['', ''], ['mb', '2']]);
  });

  it('kind 不匹配的空操作：原样返回', () => {
    const data: any = { kind: 'hash', entries: [], len: 0 };
    expect(appendCollectionPage(data, { kind: 'list', items: ['x'] })).toBe(data);
  });
});
