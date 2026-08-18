import * as crypto from 'crypto';

/**
 * 加密工具：用主密码派生的密钥对同步数据做 AES-256-GCM 加解密。
 *
 * 安全模型：
 *  - 主密码（用户输入）经 PBKDF2-SHA256 派生 32 字节密钥，主密码本身不上传
 *  - 负载**包含连接密码等敏感字段**（见 ConnectionStore.getSyncData），
 *    安全边界是端到端加密而非「不上传」：服务端只见密文 + 随机 IV + 认证标签
 *  - 每次加密使用随机 salt 与随机 IV，防止重放/模式分析
 *  - 推论：主密码遗失即数据不可恢复；主密码强度即实际安全上限
 */
export class Encryption {
  private static readonly KEY_LEN = 32; // AES-256
  private static readonly IV_LEN = 12; // GCM 推荐 IV 长度
  /** 当前派生迭代次数（新加密数据使用）。 */
  private static readonly ITERATIONS = 600_000;
  /** 旧版本加密数据使用的迭代次数（payload 无 iterations 字段时回退）。 */
  private static readonly LEGACY_ITERATIONS = 100_000;
  /**
   * 解密时接受的迭代次数上界。
   *
   * `iterations` 是从密文信封里读出来的，而信封来自服务端 —— 也就是说这个数字
   * 不完全在本地控制之下。PBKDF2 的耗时与它成正比：600k 轮约 0.5 秒，
   * 塞进 10 亿轮就是十几分钟，扩展主进程的 libuv 线程池被占死，UI 无响应且
   * 用户看不出发生了什么。
   *
   * 上界给到当前值的 3 倍多，留足未来提升迭代次数的空间（安全实践是逐年上调），
   * 又把最坏耗时压在几秒量级。超限直接抛错，不静默截断 —— 截断会让本来合法的
   * 高强度密文解不开却报「密码错误」，那是更难查的问题。
   */
  private static readonly MAX_ITERATIONS = 2_000_000;
  /**
   * GCM 认证标签长度（字节），解密时强制要求。
   *
   * GCM 规范允许截断标签，Node 也照规范实现：不显式声明 `authTagLength` 时，
   * `createDecipheriv` 会接受 4/8/12/13..16 字节的标签。而标签是从信封里读出来的，
   * 信封来自服务端 —— 于是攻击者只要把 16 字节标签截成 4 字节，伪造一条能通过
   * 完整性校验的密文所需的期望尝试次数就从 2^128 掉到 2^32。
   *
   * 危害不在"解出乱码"，而在负载内容：connections 节里带 host/port/password，
   * 一条伪造成功的记录把 host 指向攻击者的库，用户下次连上去就交出了真实口令。
   *
   * 因此这里既拒短标签也拒长标签 —— 本实现只产出 16 字节，任何其他长度都说明
   * 信封被人动过（或不是本实现产出的），没有兼容它的理由。
   */
  private static readonly TAG_LEN = 16;

  /**
   * 由主密码派生密钥（迭代次数随 payload 记录，保证新旧数据双向兼容）。
   *
   * 同步版本会阻塞调用线程约 0.4–0.6s（600k 轮），扩展主进程路径请用 deriveKeyAsync。
   * 保留同步版供测试与非交互路径使用。
   */
  static deriveKey(masterPassword: string, salt: string, iterations: number): Buffer {
    return crypto.pbkdf2Sync(
      masterPassword,
      salt,
      iterations,
      Encryption.KEY_LEN,
      'sha256',
    );
  }

  /** deriveKey 的异步版本：把 600k 轮派生放到 libuv 线程池，不冻结扩展主进程 */
  static deriveKeyAsync(masterPassword: string, salt: string, iterations: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        masterPassword,
        salt,
        iterations,
        Encryption.KEY_LEN,
        'sha256',
        (err, key) => (err ? reject(err) : resolve(key)),
      );
    });
  }

  /**
   * 加密 JSON 数据。
   * @returns 密文负载：{ salt, iterations, iv, tag, data }（iv/tag/data 为 base64）
   */
  static encrypt(plain: unknown, masterPassword: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = Encryption.deriveKey(masterPassword, salt, Encryption.ITERATIONS);
    return Encryption.sealWithKey(plain, salt, key);
  }

  /**
   * encrypt 的异步版本（密钥派生不阻塞主进程）。
   * 产物格式与 encrypt 完全一致，两者可互相解密。
   */
  static async encryptAsync(plain: unknown, masterPassword: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = await Encryption.deriveKeyAsync(masterPassword, salt, Encryption.ITERATIONS);
    return Encryption.sealWithKey(plain, salt, key);
  }

  /**
   * 解密密文负载。
   * 主密码错误或数据被篡改时抛错。
   * 旧版本（无 iterations 字段）密文回退到 LEGACY_ITERATIONS 派生。
   */
  static decrypt(encrypted: string, masterPassword: string): unknown {
    const env = Encryption.parseEnvelope(encrypted);
    const key = Encryption.deriveKey(masterPassword, env.salt, env.iterations);
    return Encryption.openWithKey(env, key);
  }

  /**
   * decrypt 的异步版本（密钥派生不阻塞主进程）。
   * 可解密 encrypt 与 encryptAsync 两种产物，含旧格式回退。
   */
  static async decryptAsync(encrypted: string, masterPassword: string): Promise<unknown> {
    const env = Encryption.parseEnvelope(encrypted);
    const key = await Encryption.deriveKeyAsync(masterPassword, env.salt, env.iterations);
    return Encryption.openWithKey(env, key);
  }

  /** 用已派生的密钥封装密文负载（encrypt/encryptAsync 共用） */
  private static sealWithKey(plain: unknown, salt: string, key: Buffer): string {
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
   * 解析密文负载并归一化迭代次数。
   *
   * 三段处理：
   *  - 缺字段 → 旧格式，回退 LEGACY_ITERATIONS
   *  - 低于下界 → 抬到 LEGACY_ITERATIONS（防止 `iterations: 1` 这类弱化派生）
   *  - 高于上界 → **抛错**（防止拿一个巨大的数字把主进程卡死，见 MAX_ITERATIONS）
   */
  private static parseEnvelope(encrypted: string): Envelope {
    const { salt, iv, tag, data, iterations } = JSON.parse(encrypted) as {
      salt: string;
      iv: string;
      tag: string;
      data: string;
      iterations?: number;
    };
    const raw = iterations ?? Encryption.LEGACY_ITERATIONS;
    if (!Number.isFinite(raw) || raw > Encryption.MAX_ITERATIONS) {
      throw new Error(
        `Refusing to decrypt: iterations ${raw} exceeds the ${Encryption.MAX_ITERATIONS} limit`,
      );
    }
    // 标签长度在派生密钥之前就校验：省掉一次 600k 轮 PBKDF2，也让"信封结构不对"
    // 与"主密码错误"成为两个可区分的错误（后者只可能在 final() 阶段抛出）。
    if (typeof tag !== 'string') {
      throw new Error('Refusing to decrypt: missing GCM auth tag in payload');
    }
    const tagBytes = Buffer.from(tag, 'base64');
    if (tagBytes.length !== Encryption.TAG_LEN) {
      throw new Error(
        `Refusing to decrypt: GCM auth tag must be ${Encryption.TAG_LEN} bytes, got ${tagBytes.length}`,
      );
    }
    return {
      salt,
      iv,
      tag,
      data,
      iterations: Math.max(raw, Encryption.LEGACY_ITERATIONS),
    };
  }

  /** 用已派生的密钥解开密文负载（decrypt/decryptAsync 共用） */
  private static openWithKey(env: Envelope, key: Buffer): unknown {
    // authTagLength 必须显式传：不传则 Node 接受截断标签，见 TAG_LEN 注释。
    // parseEnvelope 已经挡了一道，这里是第二道 —— 靠 crypto 自己拒绝，
    // 不依赖上游调用顺序。
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(env.iv, 'base64'),
      { authTagLength: Encryption.TAG_LEN },
    );
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(env.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  }
}

/** 密文负载（iterations 已归一化） */
interface Envelope {
  salt: string;
  iv: string;
  tag: string;
  data: string;
  iterations: number;
}