import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { Encryption } from '../../src/sync/encryption';

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

  it('解密旧格式密文（无 iterations 字段）仍成功', () => {
    const salt = '0'.repeat(32);
    const key = Encryption.deriveKey('master-pass', salt, 100_000);
    const iv = Buffer.alloc(12, 0);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update('{"a":1}', 'utf8'), cipher.final()]);
    const legacy = JSON.stringify({
      salt,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    });
    expect(Encryption.decrypt(legacy, 'master-pass')).toEqual({ a: 1 });
  });
});