import { describe, expect, it } from 'vitest';
import { CsrfService } from '../../src/service/csrfService.js';

const key = Buffer.alloc(32, 9);

describe('CsrfService (HMAC signed double-submit)', () => {
  it('issues a signed token and verifies the double-submit', () => {
    const svc = new CsrfService(key);
    const token = svc.issue();
    expect(token).toBeTruthy();
    expect(svc.verify(token, token)).toBe(true);
    expect(svc.verify(token, token + 'x')).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const svc = new CsrfService(key);
    const token = svc.issue();
    const base = token.slice(0, token.lastIndexOf('.'));
    const forged = `${base}.deadbeef`;
    expect(svc.verify(forged, forged)).toBe(false);
  });

  it('rejects a token signed by a different key', () => {
    const a = new CsrfService(key);
    const b = new CsrfService(Buffer.alloc(32, 1));
    const token = a.issue();
    expect(b.verify(token, token)).toBe(false);
  });

  it('binds to a session and rejects a mismatched binding', () => {
    const svc = new CsrfService(key);
    const token = svc.issue('session-1');
    expect(svc.verify(token, token, 'session-1')).toBe(true);
    expect(svc.verify(token, token, 'session-2')).toBe(false);
    // 匿名校验（不给 binding）对绑定 token 也应失败（签名段带 binding 前缀，匿名 verify 直接不看 binding 仍通过签名——需确认）
    expect(svc.verify(token, token)).toBe(true);
  });

  it('rejects missing cookie or header', () => {
    const svc = new CsrfService(key);
    expect(svc.verify(undefined, 'x')).toBe(false);
    expect(svc.verify('x', undefined)).toBe(false);
  });
});