import { describe, expect, it } from 'vitest';
import { CsrfService } from '../../src/service/csrfService.js';

describe('CsrfService', () => {
  const svc = new CsrfService();

  it('issues a non-empty token', () => {
    expect(svc.issue()).toBeTruthy();
    expect(svc.issue().length).toBeGreaterThan(16);
  });

  it('verifies matching cookie and header', () => {
    const token = svc.issue();
    expect(svc.verify(token, token)).toBe(true);
  });

  it('rejects mismatched or missing values', () => {
    expect(svc.verify(svc.issue(), svc.issue())).toBe(false);
    expect(svc.verify(undefined, 'x')).toBe(false);
    expect(svc.verify('x', undefined)).toBe(false);
  });
});