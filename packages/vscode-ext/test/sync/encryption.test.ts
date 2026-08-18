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

/**
 * GCM 认证标签长度。
 *
 * Node 的 `createDecipheriv` 在不显式声明 authTagLength 时，会接受 4/8/12/13..16
 * 字节的短标签（GCM 规范允许截断标签，Node 照规范实现）。而标签是从服务端下发的
 * 信封里读出来的 —— 攻击者把 16 字节标签截成 4 字节，伪造一条密文所需的尝试次数
 * 就从 2^128 掉到 2^32。
 *
 * 这类伪造的实际危害在于负载内容：connections 节里带 host/port/password，
 * 把 host 换成攻击者的库，用户下次连上去就把真实数据库口令交出去了。
 */
describe('Encryption 认证标签长度', () => {
  /** 用合法密钥重新封装一条密文，并把标签截断到指定长度 */
  function sealWithTruncatedTag(plain: unknown, masterPassword: string, tagLen: number): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const iterations = 100_000;
    const key = Encryption.deriveKey(masterPassword, salt, iterations);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(plain), 'utf8')),
      cipher.final(),
    ]);
    const fullTag = cipher.getAuthTag();
    return JSON.stringify({
      salt,
      iterations,
      iv: iv.toString('base64'),
      tag: fullTag.subarray(0, tagLen).toString('base64'),
      data: body.toString('base64'),
    });
  }

  it.each([4, 8, 12, 15])('拒绝 %i 字节的截断标签', (tagLen) => {
    const payload = sealWithTruncatedTag({ a: 1 }, 'master-pass', tagLen);
    expect(() => Encryption.decrypt(payload, 'master-pass')).toThrow(/auth tag/i);
  });

  it('16 字节标签正常解密（不误伤合法密文）', () => {
    const payload = sealWithTruncatedTag({ a: 1 }, 'master-pass', 16);
    expect(Encryption.decrypt(payload, 'master-pass')).toEqual({ a: 1 });
  });

  it('异步路径同样拒绝截断标签（主进程走的是这条）', async () => {
    const payload = sealWithTruncatedTag({ a: 1 }, 'master-pass', 4);
    await expect(Encryption.decryptAsync(payload, 'master-pass')).rejects.toThrow(/auth tag/i);
  });

  it('超长标签（17 字节）同样拒绝', () => {
    const payload = sealWithTruncatedTag({ a: 1 }, 'master-pass', 16);
    const env = JSON.parse(payload);
    env.tag = Buffer.concat([Buffer.from(env.tag, 'base64'), Buffer.alloc(1)]).toString('base64');
    expect(() => Encryption.decrypt(JSON.stringify(env), 'master-pass')).toThrow(/auth tag/i);
  });

  it('缺 tag 字段时报可区分的错误，而不是底层 crypto 错误', () => {
    const env = JSON.parse(Encryption.encrypt({ a: 1 }, 'master-pass'));
    delete env.tag;
    expect(() => Encryption.decrypt(JSON.stringify(env), 'master-pass')).toThrow(/auth tag/i);
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
/**
 * iterations 的边界。
 *
 * 这个字段是从密文信封里读出来的，而信封来自服务端 —— 不完全受本地控制。
 * PBKDF2 的耗时与它线性相关（600k 轮约 0.5s），所以两个方向都得管：
 *
 *  - 太小 → 派生被弱化，等于降低了主密码的实际强度
 *  - 太大 → 解密时把 libuv 线程池占死，扩展 UI 无响应且用户看不出原因
 *
 * 上界选择「抛错」而不是「截断」：截断会让合法的高强度密文解不开却报成
 * 「主密码错误」，那是更难排查的问题。
 */
describe('Encryption iterations 边界', () => {
  /** 造一个指定 iterations 的信封（内容用同样的 iterations 加密，保证本该解得开） */
  function envelopeWith(iterations: number, declared = iterations): string {
    const salt = 'a'.repeat(32);
    const key = Encryption.deriveKey('pw', salt, iterations);
    const iv = Buffer.alloc(12, 7);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update('{"ok":true}', 'utf8'), cipher.final()]);
    return JSON.stringify({
      salt,
      iterations: declared,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: enc.toString('base64'),
    });
  }

  it('超过上界直接抛错，不去真的跑派生', () => {
    const bomb = envelopeWith(100_000, 5_000_000_000);
    expect(() => Encryption.decrypt(bomb, 'pw')).toThrow(/exceeds/i);
  });

  it('异步版同样拒绝（主进程路径走的是这个）', async () => {
    const bomb = envelopeWith(100_000, 5_000_000_000);
    await expect(Encryption.decryptAsync(bomb, 'pw')).rejects.toThrow(/exceeds/i);
  });

  /**
   * JSON 里写不出 Infinity 字面量（`JSON.stringify(Infinity)` 得到 `null`），
   * 但 `1e400` 这种溢出的数字字面量是合法 JSON，`JSON.parse` 会把它变成 Infinity。
   * 所以非有限数确实是可达的输入，必须挡。
   */
  it('拒绝溢出成 Infinity 的数字字面量（1e400 是合法 JSON）', () => {
    const base = JSON.parse(envelopeWith(100_000));
    for (const literal of ['1e400', '-1e400']) {
      const raw = `{"salt":"${base.salt}","iterations":${literal},` +
        `"iv":"${base.iv}","tag":"${base.tag}","data":"${base.data}"}`;
      expect(Number.isFinite(JSON.parse(raw).iterations), '前提：确实解析成非有限数').toBe(false);
      expect(() => Encryption.decrypt(raw, 'pw'), literal).toThrow(/exceeds/i);
    }
  });

  it('略高于上界被拒（判定用的是 > 上界）', () => {
    const s = envelopeWith(100_000, 2_000_001);
    expect(() => Encryption.decrypt(s, 'pw')).toThrow(/exceeds/i);
  });

  it('恰好等于上界不被上界判定拦下（边界含等号）', () => {
    // 这条会真的跑 200 万轮派生（约 1–2 秒），因为上界检查通过之后就进派生了。
    // 密钥不对所以最终仍会抛，但错误必须是 GCM 认证失败，不能是 exceeds。
    const s = envelopeWith(100_000, 2_000_000);
    let err: unknown;
    try {
      Encryption.decrypt(s, 'pw');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String((err as Error).message)).not.toMatch(/exceeds/i);
  });

  it('低于下界的 iterations 被抬到 LEGACY（不接受弱化派生）', () => {
    // 声明 1 轮，但内容其实是用 100_000 轮加密的：
    // 解析时抬到 LEGACY_ITERATIONS=100_000，于是能解开。
    const s = envelopeWith(100_000, 1);
    expect(Encryption.decrypt(s, 'pw')).toEqual({ ok: true });
  });

  it('正常的 600k 轮密文不受影响', () => {
    const e = Encryption.encrypt({ ok: true }, 'pw');
    expect(JSON.parse(e).iterations).toBe(600_000);
    expect(Encryption.decrypt(e, 'pw')).toEqual({ ok: true });
  });
});
