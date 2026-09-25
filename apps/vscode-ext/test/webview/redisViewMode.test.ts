import { describe, expect, it } from 'vitest';
import { isKeyBrowser } from '../../webview/src/components/redis/types';

describe('isKeyBrowser（RedisView 三栏 vs 服务器状态分支）', () => {
  it('db 为 null → 非键浏览器（渲染 ServerStatus）', () => {
    expect(isKeyBrowser(null)).toBe(false);
  });

  it('db 为数字（含 0）→ 键浏览器', () => {
    expect(isKeyBrowser(0)).toBe(true);
    expect(isKeyBrowser(2)).toBe(true);
  });
});
