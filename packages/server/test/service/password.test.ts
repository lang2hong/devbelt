import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/service/password.js';

describe('password (Argon2id)', () => {
  const pw = 'correct-horse-battery-staple';

  it('hashes with self-describing fixed params and verifies', () => {
    const h = hashPassword(pw);
    expect(h.startsWith('argon2id$m=65536,t=3,p=1$')).toBe(true);
    expect(verifyPassword(pw, h)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const h = hashPassword(pw);
    expect(verifyPassword('wrong-password', h)).toBe(false);
  });

  it('uses a unique salt per call', () => {
    expect(hashPassword(pw)).not.toBe(hashPassword(pw));
  });

  it('rejects non-argon2id / corrupted formats', () => {
    expect(verifyPassword(pw, 'scrypt$aa$bb')).toBe(false);
    expect(verifyPassword(pw, 'nonsense')).toBe(false);
    expect(verifyPassword(pw, 'argon2id$nonsense')).toBe(false);
  });
});