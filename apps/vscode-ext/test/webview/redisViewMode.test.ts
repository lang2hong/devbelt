import { describe, expect, it } from 'vitest';
import { computeStreamDone, isKeyBrowser } from '../../webview/src/components/redis/types';

describe('isKeyBrowser（RedisView 三栏 vs 服务器状态分支）', () => {
  it('db 为 null → 非键浏览器（渲染 ServerStatus）', () => {
    expect(isKeyBrowser(null)).toBe(false);
  });

  it('db 为数字（含 0）→ 键浏览器', () => {
    expect(isKeyBrowser(0)).toBe(true);
    expect(isKeyBrowser(2)).toBe(true);
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
