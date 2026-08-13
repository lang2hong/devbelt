import * as crypto from 'crypto';

/**
 * 加密工具：用主密码派生的密钥对同步数据做 AES-256-GCM 加解密。
 *
 * 安全模型：
 *  - 主密码（用户输入）经 PBKDF2 派生 32 字节密钥
 *  - 明文数据绝不上传，服务器只存密文 + 随机 IV + 认证标签
 *  - 每次加密使用随机 IV，防止重放/模式分析
 */
export class Encryption {
  private static readonly KEY_LEN = 32; // AES-256
  private static readonly IV_LEN = 12; // GCM 推荐 IV 长度
  /** 当前派生迭代次数（新加密数据使用）。 */
  private static readonly ITERATIONS = 600_000;
  /** 旧版本加密数据使用的迭代次数（payload 无 iterations 字段时回退）。 */
  private static readonly LEGACY_ITERATIONS = 100_000;

  /** 由主密码派生密钥（迭代次数随 payload 记录，保证新旧数据双向兼容） */
  static deriveKey(masterPassword: string, salt: string, iterations: number): Buffer {
    return crypto.pbkdf2Sync(
      masterPassword,
      salt,
      iterations,
      Encryption.KEY_LEN,
      'sha256',
    );
  }

  /**
   * 加密 JSON 数据。
   * @returns 密文负载：{ salt, iterations, iv, tag, data }（iv/tag/data 为 base64）
   */
  static encrypt(plain: unknown, masterPassword: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = Encryption.deriveKey(masterPassword, salt, Encryption.ITERATIONS);
    const iv = crypto.randomBytes(Encryption.IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const payload = Buffer.from(JSON.stringify(plain), 'utf8');
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      salt,
      iterations: Encryption.ITERATIONS,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    });
  }

  /**
   * 解密密文负载。
   * 主密码错误或数据被篡改时抛错。
   * 旧版本（无 iterations 字段）密文回退到 LEGACY_ITERATIONS 派生。
   */
  static decrypt(encrypted: string, masterPassword: string): unknown {
    const { salt, iv, tag, data, iterations } = JSON.parse(encrypted) as {
      salt: string;
      iv: string;
      tag: string;
      data: string;
      iterations?: number;
    };
    const safeIterations = Math.max(iterations ?? Encryption.LEGACY_ITERATIONS, Encryption.LEGACY_ITERATIONS);
    const key = Encryption.deriveKey(
      masterPassword,
      salt,
      safeIterations,
    );
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  }
}