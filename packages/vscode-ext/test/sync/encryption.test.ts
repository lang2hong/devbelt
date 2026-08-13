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

  it('篡改认证标签后解密抛错（GCM 完整性）', () => {
    const encrypted = Encryption.encrypt({ a: 1 }, 'master-pass');
    const env = JSON.parse(encrypted);
    const tag = Buffer.from(env.tag, 'base64');
    tag[0] ^= 0xff;
    env.tag = tag.toString('base64');
    expect(() => Encryption.decrypt(JSON.stringify(env), 'master-pass')).toThrow();
  });

  it('篡改密文体后解密抛错', () => {
    const encrypted = Encryption.encrypt({ a: 1 }, 'master-pass');
    const env = JSON.parse(encrypted);
    const data = Buffer.from(env.data, 'base64');
    data[0] ^= 0xff;
    env.data = data.toString('base64');
    expect(() => Encryption.decrypt(JSON.stringify(env), 'master-pass')).toThrow();
  });
});

describe('Encryption（异步派生）', () => {
  it('encryptAsync 后 decryptAsync 可还原', async () => {
    const data = { connections: [{ host: 'h', password: 'p' }] };
    const encrypted = await Encryption.encryptAsync(data, 'master-pass');
    await expect(Encryption.decryptAsync(encrypted, 'master-pass')).resolves.toEqual(data);
  });

  it('同步加密的密文可被异步解密（迁移兼容）', async () => {
    const data = { a: 1, b: 'two' };
    const encrypted = Encryption.encrypt(data, 'master-pass');
    await expect(Encryption.decryptAsync(encrypted, 'master-pass')).resolves.toEqual(data);
  });

  it('异步加密的密文可被同步解密（反向兼容）', async () => {
    const data = { a: 1, b: 'two' };
    const encrypted = await Encryption.encryptAsync(data, 'master-pass');
    expect(Encryption.decrypt(encrypted, 'master-pass')).toEqual(data);
  });

  it('两版产物的信封结构一致（salt/iterations/iv/tag/data）', async () => {
    const sync = JSON.parse(Encryption.encrypt({ a: 1 }, 'p'));
    const async = JSON.parse(await Encryption.encryptAsync({ a: 1 }, 'p'));
    expect(Object.keys(async).sort()).toEqual(Object.keys(sync).sort());
    expect(async.iterations).toBe(sync.iterations);
    expect(async.salt).toHaveLength(sync.salt.length);
  });

  it('deriveKeyAsync 与 deriveKey 对相同输入产出相同密钥', async () => {
    const salt = 'a'.repeat(32);
    const sync = Encryption.deriveKey('pw', salt, 1000);
    const async = await Encryption.deriveKeyAsync('pw', salt, 1000);
    expect(async.equals(sync)).toBe(true);
    expect(async).toHaveLength(32);
  });

  it('错误主密码时 decryptAsync 拒绝而非返回错误数据', async () => {
    const encrypted = await Encryption.encryptAsync({ a: 1 }, 'correct');
    await expect(Encryption.decryptAsync(encrypted, 'wrong')).rejects.toThrow();
  });

  it('decryptAsync 也支持旧格式（无 iterations 字段）回退', async () => {
    const salt = '0'.repeat(32);
    const key = await Encryption.deriveKeyAsync('master-pass', salt, 100_000);
    const iv = Buffer.alloc(12, 0);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update('{"a":1}', 'utf8'), cipher.final()]);
    const legacy = JSON.stringify({
      salt,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    });
    await expect(Encryption.decryptAsync(legacy, 'master-pass')).resolves.toEqual({ a: 1 });
  });

  it('每次异步加密使用新 salt 与新 IV', async () => {
    const e1 = JSON.parse(await Encryption.encryptAsync({ a: 1 }, 'p'));
    const e2 = JSON.parse(await Encryption.encryptAsync({ a: 1 }, 'p'));
    expect(e1.salt).not.toBe(e2.salt);
    expect(e1.iv).not.toBe(e2.iv);
  });
});