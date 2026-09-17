import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './returnTo';

describe('safeReturnTo', () => {
  it('allows /console/ paths', () => {
    expect(safeReturnTo('/console/organizations')).toBe('/console/organizations');
    expect(safeReturnTo('/console/account/devices')).toBe('/console/account/devices');
  });

  it('falls back on missing or empty input', () => {
    expect(safeReturnTo(null)).toBe('/console/account');
    expect(safeReturnTo(undefined)).toBe('/console/account');
    expect(safeReturnTo('')).toBe('/console/account');
  });

  it('rejects absolute and protocol-relative URLs', () => {
    expect(safeReturnTo('https://evil.example.com')).toBe('/console/account');
    expect(safeReturnTo('//evil.example.com/x')).toBe('/console/account');
  });

  it('rejects non-console paths', () => {
    expect(safeReturnTo('/login')).toBe('/console/account');
    expect(safeReturnTo('/api')).toBe('/console/account');
  });

  it('returns pathname only, dropping query string', () => {
    expect(safeReturnTo('/console/organizations?returnTo=/login')).toBe('/console/organizations');
  });
});