import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/modules/auth/service/password.js';

describe('password (Argon2id)', () => {
  const pw = 'correct-horse-battery-staple';

  it('hashes with self-describing fixed params and verifies', async () => {
    const h = await hashPassword(pw);
    expect(h.startsWith('argon2id$m=65536,t=3,p=1$')).toBe(true);
    expect(await verifyPassword(pw, h)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const h = await hashPassword(pw);
    expect(await verifyPassword('wrong-password', h)).toBe(false);
  });

  it('uses a unique salt per call', async () => {
    expect(await hashPassword(pw)).not.toBe(await hashPassword(pw));
  });

  it('rejects non-argon2id / corrupted formats', async () => {
    expect(await verifyPassword(pw, 'scrypt$aa$bb')).toBe(false);
    expect(await verifyPassword(pw, 'nonsense')).toBe(false);
    expect(await verifyPassword(pw, 'argon2id$nonsense')).toBe(false);
  });

  it('rejects params beyond the sanity bounds (tampered hash row)', async () => {
    // m 超过 1 GiB 上限：不得据此分配内存，直接判失败。
    const salt = Buffer.alloc(16).toString('base64');
    const fake = `argon2id$m=99999999,t=3,p=1$${salt}$${Buffer.alloc(32).toString('base64')}`;
    expect(await verifyPassword(pw, fake)).toBe(false);
  });

  it('keeps the event loop responsive while hashing', async () => {
    // 回归防线：Argon2id 必须在 worker 里算。若有人把它挪回主线程，
    // 这段期间定时器一次都不会触发，断言即失败。
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 10);
    try {
      await hashPassword(pw);
    } finally {
      clearInterval(iv);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
