import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ Uri: { joinPath: () => ({}) } }));

const { getNonce } = await import('../../src/webview/html');

describe('getNonce（CSP nonce）', () => {
  it('返回 base64 编码的 16 字节随机值', () => {
    const nonce = getNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it('每次调用都不同', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(getNonce());
    expect(seen.size).toBe(200);
  });

  it('熵足够：128 bit（Math.random 的 PRNG 输出可预测，不可用于 CSP）', () => {
    // 16 字节 = 128 bit，远高于暴力猜测 nonce 绕过 CSP 的可行范围
    expect(Buffer.from(getNonce(), 'base64').length * 8).toBe(128);
  });

  it('不含会破坏 HTML 属性的字符', () => {
    for (let i = 0; i < 100; i++) {
      const nonce = getNonce();
      expect(nonce).not.toContain('"');
      expect(nonce).not.toContain("'");
      expect(nonce).not.toContain('<');
      expect(nonce).not.toContain('>');
      expect(nonce).not.toContain(' ');
    }
  });
});
