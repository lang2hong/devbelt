import { describe, expect, it } from 'vitest';
import { Encryption } from './encryption';

describe('Encryption（同步加密）', () => {
  it('加密后可解密还原原始数据', () => {
    const data = { connections: [{ host: 'x' }], groups: [] };
    const encrypted = Encryption.encrypt(data, 'master-pass');
    const decrypted = Encryption.decrypt(encrypted, 'master-pass');
    expect(decrypted).toEqual(data);
  });

  it('每次加密产生不同密文（随机 IV）', () => {
    const data = { a: 1 };
    const e1 = Encryption.encrypt(data, 'p');
    const e2 = Encryption.encrypt(data, 'p');
    expect(e1).not.toBe(e2);
  });

  it('错误主密码解密抛错', () => {
    const encrypted = Encryption.encrypt({ a: 1 }, 'correct');
    expect(() => Encryption.decrypt(encrypted, 'wrong')).toThrow();
  });
});