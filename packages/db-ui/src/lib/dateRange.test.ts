import { describe, expect, it } from 'vitest';
import { toFromIso, toInclusiveEndIso } from './dateRange';

describe('toFromIso', () => {
  it('empty / invalid → undefined', () => {
    expect(toFromIso('')).toBeUndefined();
    expect(toFromIso('not-a-date')).toBeUndefined();
  });

  it('keeps the chosen minute start instant', () => {
    const iso = toFromIso('2026-09-13T10:30');
    expect(iso).toBeTruthy();
    expect(Number.isNaN(new Date(iso!).getTime())).toBe(false);
  });
});

describe('toInclusiveEndIso', () => {
  it('empty / invalid → undefined', () => {
    expect(toInclusiveEndIso('')).toBeUndefined();
    expect(toInclusiveEndIso('not-a-date')).toBeUndefined();
  });

  it('minute-precision input is expanded to :59.999 (offsets-timezone independently)', () => {
    const from = new Date(toFromIso('2026-09-13T10:30')!).getTime();
    const end = new Date(toInclusiveEndIso('2026-09-13T10:30')!).getTime();
    expect(end - from).toBe(59 * 1000 + 999);
  });

  it('second-precision input is preserved, not expanded', () => {
    expect(toInclusiveEndIso('2026-09-13T10:30:15')).toBe(toFromIso('2026-09-13T10:30:15'));
  });
});