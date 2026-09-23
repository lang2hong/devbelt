import { describe, expect, it } from 'vitest';
import { decodeBase32Loose, encodeBase32UpperCaseNoPadding } from '../../src/authenticator/base32';

describe('base32', () => {
  it('empty string roundtrips', () => {
    expect(encodeBase32UpperCaseNoPadding(new Uint8Array(0))).toBe('');
    expect(decodeBase32Loose('')).toEqual(new Uint8Array(0));
  });

  it('encodes RFC test vector "foobar" (no padding output)', () => {
    // "foobar" → MZXW6YTBOI====== with padding; no-pad = MZXW6YTBOI
    const bytes = new TextEncoder().encode('foobar');
    expect(encodeBase32UpperCaseNoPadding(bytes)).toBe('MZXW6YTBOI');
  });

  it('decodes with uppercase', () => {
    const bytes = decodeBase32Loose('MZXW6YTBOI');
    expect(new TextDecoder().decode(bytes)).toBe('foobar');
  });

  it('decodes case-insensitive (lowercase)', () => {
    const bytes = decodeBase32Loose('mzxw6ytboi');
    expect(new TextDecoder().decode(bytes)).toBe('foobar');
  });

  it('decodes with optional padding (=)', () => {
    const bytes = decodeBase32Loose('MZXW6YTBOI======');
    expect(new TextDecoder().decode(bytes)).toBe('foobar');
  });

  it('ignores ASCII whitespace (spaces/tabs/newlines)', () => {
    const bytes = decodeBase32Loose('MZX W6Y\tTBO\nI');
    expect(new TextDecoder().decode(bytes)).toBe('foobar');
  });

  it('rejects digits that are not in the alphabet (0,1,8,9)', () => {
    for (const ch of ['0', '1', '8', '9']) {
      expect(() => decodeBase32Loose(ch)).toThrow();
    }
  });

  it('rejects non-ASCII fullwidth letters', () => {
    // Fullwidth 'Ａ' (U+FF21) is NOT in ASCII range; must reject
    expect(() => decodeBase32Loose('Ａ')).toThrow();
  });

  it('rejects Unicode chars that uppercase-fold to ASCII letters', () => {
    // U+017F 长 s → 'S'；U+0131 无点 i → 'I'；U+212A Kelvin 号。都不得被静默接受。
    for (const ch of ['\u017F', '\u0131', '\u212A']) {
      expect(() => decodeBase32Loose(ch)).toThrow();
    }
  });

  it('rejects padding that is not trailing', () => {
    expect(() => decodeBase32Loose('MZ=XW6YTBOI')).toThrow(/padding/);
  });

  it('rejects invalid length residue classes (mod 8 ∈ {1,3,6})', () => {
    expect(() => decodeBase32Loose('M')).toThrow(/length/);       // 1
    expect(() => decodeBase32Loose('MZX')).toThrow(/length/);     // 3
    expect(() => decodeBase32Loose('MZXW6Y')).toThrow(/length/);  // 6
  });

  it('accepts valid length residue classes (mod 8 ∈ {2,4,5,7,0})', () => {
    for (const s of ['MZ', 'MZXW', 'MZXW6', 'MZXW6YT', 'MZXW6YTB']) {
      expect(() => decodeBase32Loose(s)).not.toThrow();
    }
  });

  it('roundtrip arbitrary bytes (0x00..0xFF sampled)', () => {
    for (let len = 0; len <= 40; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 31 + 7) & 0xff;
      const enc = encodeBase32UpperCaseNoPadding(bytes);
      const dec = decodeBase32Loose(enc);
      expect(Array.from(dec)).toEqual(Array.from(bytes));
    }
  });
});
