import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './returnTo';

describe('safeReturnTo', () => {
  it('allows app-relative console paths', () => {
    expect(safeReturnTo('/plans')).toBe('/plans');
    expect(safeReturnTo('/account/devices')).toBe('/account/devices');
  });

  it('falls back on missing or empty input', () => {
    expect(safeReturnTo(null)).toBe('/account');
    expect(safeReturnTo(undefined)).toBe('/account');
    expect(safeReturnTo('')).toBe('/account');
  });

  it('rejects absolute and protocol-relative URLs', () => {
    expect(safeReturnTo('https://evil.example.com')).toBe('/account');
    expect(safeReturnTo('//evil.example.com/x')).toBe('/account');
  });

  it('rejects identity, api and base-prefixed paths', () => {
    expect(safeReturnTo('/login')).toBe('/account');
    expect(safeReturnTo('/api')).toBe('/account');
  });

  it('returns pathname only, dropping query string', () => {
    expect(safeReturnTo('/plans?returnTo=/login')).toBe('/plans');
  });
});