import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SCRYPT_PREFIX = 'scrypt$';
const SCRYPT_KEYLEN = 32;

/**
 * 密码哈希（scrypt，随机盐）：`scrypt$<salt>$<hash>`。
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${SCRYPT_PREFIX}${salt}$${hash}`;
}

/**
 * 校验密码。
 *
 * ## 为什么不再有 legacy sha256 分支
 *
 * 早期版本用 `sha256(JWT_SECRET + password)`，即**把签名密钥当作密码盐**。
 * 这个耦合的代价是密钥轮换会让所有尚未登录过（因而尚未被就地升级为 scrypt）的
 * 用户永久无法登录 —— 一个安全操作（轮换密钥）反而造成数据损失。
 *
 * 已确认生产库中 legacy 格式用户数为 0，因此直接删除该分支，而不是引入
 * `LEGACY_PASSWORD_SALT` 之类的配置项去维持这个耦合。删掉之后 `JWT_SECRET`
 * 与密码哈希彻底无关，轮换密钥的唯一代价是所有人重新登录一次。
 *
 * 万一将来仍有 sha256 哈希入库（例如从旧备份恢复），那个用户会验证失败，
 * 正确出路是走密码重置流程 —— 而不是把弱哈希继续接受下去。
 *
 * 使用 timingSafeEqual 防止时序攻击。
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (!stored.startsWith(SCRYPT_PREFIX)) return false;
  const body = stored.slice(SCRYPT_PREFIX.length);
  const sep = body.lastIndexOf('$');
  if (sep <= 0) return false;
  const salt = body.slice(0, sep);
  const expected = body.slice(sep + 1);
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
