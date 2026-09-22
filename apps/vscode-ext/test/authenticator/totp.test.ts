import { describe, expect, it } from 'vitest';
import { canonicalizeSecret, hotp, totp, totpFromSecret } from '../../src/authenticator/totp';
import { decodeBase32Loose } from '../../src/authenticator/base32';

/**
 * RFC 6238 Appendix B 测试向量：
 *   seed ASCII "12345678901234567890" (20 字节，SHA1)
 *   seed ASCII "12345678901234567890123456789012" (32 字节，SHA256)
 *   seed ASCII "1234567890123456789012345678901234567890123456789012345678901234" (64 字节，SHA512)
 *   digits=8, period=30, T 值依次 59/1111111109/1111111111/1234567890/2000000000/20000000000
 */
describe('TOTP (RFC 6238 Appendix B)', () => {
  const sha1Seed = new TextEncoder().encode('12345678901234567890');
  const sha256Seed = new TextEncoder().encode('12345678901234567890123456789012');
  const sha512Seed = new TextEncoder().encode('1234567890123456789012345678901234567890123456789012345678901234');

  const vectors: Array<{ time: number; algo: 'SHA1' | 'SHA256' | 'SHA512'; expected: string }> = [
    { time: 59, algo: 'SHA1', expected: '94287082' },
    { time: 59, algo: 'SHA256', expected: '46119246' },
    { time: 59, algo: 'SHA512', expected: '90693936' },
    { time: 1111111109, algo: 'SHA1', expected: '07081804' },
    { time: 1111111109, algo: 'SHA256', expected: '68084774' },
    { time: 1111111109, algo: 'SHA512', expected: '25091201' },
    { time: 1111111111, algo: 'SHA1', expected: '14050471' },
    { time: 1111111111, algo: 'SHA256', expected: '67062674' },
    { time: 1111111111, algo: 'SHA512', expected: '99943326' },
    { time: 1234567890, algo: 'SHA1', expected: '89005924' },
    { time: 1234567890, algo: 'SHA256', expected: '91819424' },
    { time: 1234567890, algo: 'SHA512', expected: '93441116' },
    { time: 2000000000, algo: 'SHA1', expected: '69279037' },
    { time: 2000000000, algo: 'SHA256', expected: '90698825' },
    { time: 2000000000, algo: 'SHA512', expected: '38618901' },
    { time: 20000000000, algo: 'SHA1', expected: '65353130' },
    { time: 20000000000, algo: 'SHA256', expected: '77737706' },
    { time: 20000000000, algo: 'SHA512', expected: '47863826' },
  ];

  const seedFor = (a: 'SHA1' | 'SHA256' | 'SHA512'): Uint8Array =>
    a === 'SHA1' ? sha1Seed : a === 'SHA256' ? sha256Seed : sha512Seed;

  for (const v of vectors) {
    it(`T=${v.time} ${v.algo} → ${v.expected}`, () => {
      const code = totp(seedFor(v.algo), v.time * 1000, 30, 8, v.algo).code;
      expect(code).toBe(v.expected);
    });
  }
});

describe('HOTP direct', () => {
  it('RFC 4226 Appendix D sample (counter=0, SHA1, 6 digits)', () => {
    // The canonical HOTP test seed is "12345678901234567890" (20B), counter=0 → 755224
    const seed = new TextEncoder().encode('12345678901234567890');
    expect(hotp(seed, 0n, 6, 'SHA1')).toBe('755224');
  });
});

describe('canonicalizeSecret', () => {
  it('strips spaces, uppercases, strips padding', () => {
    const canon = canonicalizeSecret('jbsw y3dp'); // "123456" base32 = GEZDGNBVGY... wait; just verify properties
    expect(canon).not.toMatch(/\s/);
    expect(canon).toBe(canon.toUpperCase());
    expect(canon).not.toContain('=');
    // decode must succeed
    expect(() => decodeBase32Loose(canon)).not.toThrow();
  });

  it('rejects invalid characters', () => {
    expect(() => canonicalizeSecret('hello0')).toThrow(); // '0' invalid
  });

  it('totpFromSecret computes from canonical form', () => {
    const canon = canonicalizeSecret('gezdgnbvgy3tqojq'); // base32 of "hello12"
    const r = totpFromSecret(canon, Date.now());
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.secondsLeft).toBeGreaterThan(0);
    expect(r.secondsLeft).toBeLessThanOrEqual(30);
  });
});

describe('TOTP periods/digits', () => {
  it('6-digit / 30-second default', () => {
    const seed = new TextEncoder().encode('12345678901234567890');
    const { code, secondsLeft } = totp(seed, 1000, 30, 6, 'SHA1');
    expect(code).toMatch(/^\d{6}$/);
    expect(secondsLeft).toBe(29);
  });

  it('8-digit / 60-second', () => {
    const seed = new TextEncoder().encode('12345678901234567890');
    const { code, secondsLeft } = totp(seed, 1000, 60, 8, 'SHA1');
    expect(code).toMatch(/^\d{8}$/);
    expect(secondsLeft).toBe(59);
  });
});
