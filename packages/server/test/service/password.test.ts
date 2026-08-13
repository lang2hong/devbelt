import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { hashPassword, verifyPassword, upgradePasswordIfNeeded } from '../../src/service/password.js';

const LEGACY_SALT = 'legacy-jwt-secret';

function legacyHash(password: string, salt = LEGACY_SALT): string {
  return createHash('sha256').update(`${salt}${password}`).digest('hex');
}

describe('hashPassword', () => {
  it('emits scrypt$<salt>$<hash> with hex parts', () => {
    const stored = hashPassword('correct horse battery');
    const [scheme, salt, hash] = stored.split('$');
    expect(scheme).toBe('scrypt');
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses a fresh salt per call, so equal passwords hash differently', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(a.split('$')[1]).not.toBe(b.split('$')[1]);
  });
});

describe('verifyPassword — scrypt path', () => {
  const stored = hashPassword('s3cret-password');

  it('accepts the right password', () => {
    expect(verifyPassword('s3cret-password', stored, LEGACY_SALT)).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(verifyPassword('s3cret-passwore', stored, LEGACY_SALT)).toBe(false);
  });

  it('ignores legacySalt entirely for scrypt hashes', () => {
    expect(verifyPassword('s3cret-password', stored, 'a-totally-different-salt')).toBe(true);
  });

  it('rejects a malformed scrypt record instead of throwing', () => {
    expect(verifyPassword('whatever', 'scrypt$no-separator', LEGACY_SALT)).toBe(false);
    expect(verifyPassword('whatever', 'scrypt$$abc', LEGACY_SALT)).toBe(false);
  });

  it('rejects when the stored hash has a different length (timingSafeEqual guard)', () => {
    const [, salt] = hashPassword('x').split('$');
    expect(verifyPassword('x', `scrypt$${salt}$dead`, LEGACY_SALT)).toBe(false);
  });
});

describe('verifyPassword — legacy sha256 path', () => {
  it('accepts a legacy hash built from the static salt', () => {
    expect(verifyPassword('old-password', legacyHash('old-password'), LEGACY_SALT)).toBe(true);
  });

  it('rejects a legacy hash when the salt differs', () => {
    expect(verifyPassword('old-password', legacyHash('old-password', 'other'), LEGACY_SALT)).toBe(false);
  });

  it('rejects a wrong password against a legacy hash', () => {
    expect(verifyPassword('nope', legacyHash('old-password'), LEGACY_SALT)).toBe(false);
  });

  it('rejects a stored value that is not a sha256 hex at all', () => {
    expect(verifyPassword('old-password', 'garbage', LEGACY_SALT)).toBe(false);
  });
});

describe('upgradePasswordIfNeeded', () => {
  it('flags legacy hashes for rehash', () => {
    expect(upgradePasswordIfNeeded(legacyHash('old-password'))).toBe(true);
  });

  it('leaves scrypt hashes alone', () => {
    expect(upgradePasswordIfNeeded(hashPassword('new-password'))).toBe(false);
  });
});
