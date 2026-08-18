import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { hashPassword, verifyPassword } from '../../src/service/password.js';

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

describe('verifyPassword', () => {
  const stored = hashPassword('s3cret-password');

  it('accepts the right password', () => {
    expect(verifyPassword('s3cret-password', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    expect(verifyPassword('s3cret-passwore', stored)).toBe(false);
  });

  it('rejects a malformed scrypt record instead of throwing', () => {
    expect(verifyPassword('whatever', 'scrypt$no-separator')).toBe(false);
    expect(verifyPassword('whatever', 'scrypt$$abc')).toBe(false);
  });

  it('rejects when the stored hash has a different length (timingSafeEqual guard)', () => {
    const [, salt] = hashPassword('x').split('$');
    expect(verifyPassword('x', `scrypt$${salt}$dead`)).toBe(false);
  });
});

/**
 * legacy sha256 分支已删除。
 *
 * 旧格式是 `sha256(JWT_SECRET + password)` —— 把签名密钥当密码盐。这个耦合让
 * 「轮换 JWT_SECRET」这个安全操作变成一次数据损失事件：所有尚未登录过（因而
 * 尚未被就地升级为 scrypt）的用户永久无法登录。
 *
 * 生产库确认 legacy 格式用户数为 0，因此直接删除分支，而不是引入
 * LEGACY_PASSWORD_SALT 之类的配置去维持耦合。
 *
 * 这几条断言把「不再接受弱哈希」钉住，防止有人为了兼容把分支加回来。
 */
describe('legacy sha256 哈希不再被接受', () => {
  const legacy = (password: string, salt: string) =>
    createHash('sha256').update(`${salt}${password}`).digest('hex');

  it('拒绝 legacy 格式，即使密码正确', () => {
    expect(verifyPassword('old-password', legacy('old-password', 'any-salt'))).toBe(false);
  });

  it('拒绝任何非 scrypt$ 前缀的存储值', () => {
    expect(verifyPassword('old-password', 'garbage')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$abc$def')).toBe(false);
  });

  it('verifyPassword 只接受两个参数（不再有 legacySalt）', () => {
    // 签名回归：多传一个参数在类型层面就该失败，运行时也不该改变结果
    expect(verifyPassword.length).toBe(2);
  });
});
