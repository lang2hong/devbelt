import { describe, expect, it } from 'vitest';
import { computeStreamDone, isKeyBrowserPanel } from '../../webview/src/components/redis/types';

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
