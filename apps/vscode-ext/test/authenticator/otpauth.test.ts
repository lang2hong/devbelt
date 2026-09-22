import { describe, expect, it } from 'vitest';
import { parseOtpauthUri, buildOtpauthUri } from '../../src/authenticator/otpauth';
import { canonicalizeSecret } from '../../src/authenticator/totp';

describe('parseOtpauthUri', () => {
  it('parses minimal URI (no issuer param, no account)', () => {
    const r = parseOtpauthUri('otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP');
    expect(r.issuer).toBe('');
    expect(r.account).toBe('Example');
    expect(r.algorithm).toBe('SHA1');
    expect(r.digits).toBe(6);
    expect(r.period).toBe(30);
    expect(r.secret).toBe(canonicalizeSecret('JBSWY3DPEHPK3PXP'));
  });

  it('parses with issuer in query and label issuer:account', () => {
    const r = parseOtpauthUri('otpauth://totp/Acme:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA256&digits=8&period=60');
    expect(r.issuer).toBe('Acme');
    expect(r.account).toBe('alice@example.com');
    expect(r.algorithm).toBe('SHA256');
    expect(r.digits).toBe(8);
    expect(r.period).toBe(60);
  });

  it('query issuer overrides label issuer', () => {
    const r = parseOtpauthUri('otpauth://totp/OldIssuer:alice?secret=JBSWY3DPEHPK3PXP&issuer=NewIssuer');
    expect(r.issuer).toBe('NewIssuer');
  });

  it('only splits on first colon (account may contain colons)', () => {
    const r = parseOtpauthUri('otpauth://totp/A:user:with:colons?secret=JBSWY3DPEHPK3PXP');
    expect(r.issuer).toBe('A');
    expect(r.account).toBe('user:with:colons');
  });

  it('rejects non-totp type (hotp)', () => {
    expect(() => parseOtpauthUri('otpauth://hotp/foo?secret=JBSWY3DPEHPK3PXP')).toThrow(/unsupported otp type/);
  });

  it('rejects missing secret', () => {
    expect(() => parseOtpauthUri('otpauth://totp/foo')).toThrow(/missing secret/);
  });

  it('rejects invalid protocol', () => {
    expect(() => parseOtpauthUri('https://example.com')).toThrow(/invalid otpauth protocol/);
  });

  it('rejects invalid algorithm', () => {
    expect(() => parseOtpauthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=MD5')).toThrow(/invalid algorithm/);
  });

  it('trims whitespace and strips zero-width chars', () => {
    const r = parseOtpauthUri('\u200B  otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP  ');
    expect(r.account).toBe('Example');
  });

  it('handles URL-encoded Chinese/issuer', () => {
    const uri = 'otpauth://totp/%E4%B8%AD%E6%96%87:alice?secret=JBSWY3DPEHPK3PXP&issuer=%E4%B8%AD%E6%96%87';
    const r = parseOtpauthUri(uri);
    expect(r.issuer).toBe('中文');
    expect(r.account).toBe('alice');
  });

  it('digits other than 8 default to 6', () => {
    const r = parseOtpauthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&digits=7');
    expect(r.digits).toBe(6);
  });

  it('period other than 60 defaults to 30', () => {
    const r = parseOtpauthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&period=15');
    expect(r.period).toBe(30);
  });
});

describe('buildOtpauthUri', () => {
  it('roundtrips parse → build (idempotent)', () => {
    const original = 'otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA256&digits=8&period=60';
    const parsed = parseOtpauthUri(original);
    const rebuilt = buildOtpauthUri({
      issuer: parsed.issuer,
      account: parsed.account,
      secret: parsed.secret,
      algorithm: parsed.algorithm,
      digits: parsed.digits,
      period: parsed.period,
    });
    const reparsed = parseOtpauthUri(rebuilt);
    expect(reparsed.issuer).toBe(parsed.issuer);
    expect(reparsed.account).toBe(parsed.account);
    expect(reparsed.algorithm).toBe(parsed.algorithm);
    expect(reparsed.digits).toBe(parsed.digits);
    expect(reparsed.period).toBe(parsed.period);
    expect(reparsed.secret).toBe(parsed.secret);
  });

  it('emits uppercase no-pad no-space secret', () => {
    const canon = canonicalizeSecret('jbsw y3dp');
    const uri = buildOtpauthUri({ issuer: 'A', account: 'b', secret: canon });
    expect(uri).toMatch(/secret=[A-Z2-7]+/);
    expect(uri).not.toContain('%20');
    // query values are uppercase (secrets/alg/digits/period); issuer label may be encoded uppercase
    expect(uri).toMatch(/algorithm=SHA1/);
  });

  it('no-colon label when account empty', () => {
    const uri = buildOtpauthUri({ issuer: 'OnlyIssuer', secret: 'JBSWY3DPEHPK3PXP' });
    expect(uri).not.toMatch(/OnlyIssuer:/);
    expect(uri).toContain('otpauth://totp/OnlyIssuer?');
  });

  it('default algorithm/digits/period are still written explicitly', () => {
    const uri = buildOtpauthUri({ issuer: 'A', account: 'b', secret: 'JBSWY3DPEHPK3PXP' });
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('roundtrips non-ASCII issuer/account (no double-encoding of query issuer)', () => {
    const secret = canonicalizeSecret('JBSWY3DPEHPK3PXP');
    const built = buildOtpauthUri({ issuer: '中文', account: '爱丽丝', secret });
    const reparsed = parseOtpauthUri(built);
    expect(reparsed.issuer).toBe('中文');
    expect(reparsed.account).toBe('爱丽丝');
    expect(reparsed.secret).toBe(secret);
  });

  it('roundtrips issuer with special characters (/, ?, &, %)', () => {
    const secret = canonicalizeSecret('JBSWY3DPEHPK3PXP');
    const tricky = 'A&B/C?x%y';
    const built = buildOtpauthUri({ issuer: tricky, account: 'u', secret });
    const reparsed = parseOtpauthUri(built);
    expect(reparsed.issuer).toBe(tricky);
  });

  it('encodes query params per RFC 3986 (space → %20, not +)', () => {
    const secret = canonicalizeSecret('JBSWY3DPEHPK3PXP');
    const built = buildOtpauthUri({ issuer: 'A B', account: 'c d', secret });
    expect(built).toContain('issuer=A%20B');
    expect(built).not.toContain('issuer=A+B');
    // literal '+' must be %2B, never bare '+'
    const plus = buildOtpauthUri({ issuer: 'A+B', account: 'c', secret });
    expect(plus).toContain('issuer=A%2BB');
    const reparsed = parseOtpauthUri(built);
    expect(reparsed.issuer).toBe('A B');
    expect(reparsed.account).toBe('c d');
  });

  it('parse rejects a label with a stray % (clean error, not URIError)', () => {
    expect(() => parseOtpauthUri('otpauth://totp/bad%zz?secret=JBSWY3DPEHPK3PXP')).toThrow(/invalid otpauth URI/);
  });
});
