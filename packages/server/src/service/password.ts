import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SCRYPT_PREFIX = 'scrypt$';
const SCRYPT_KEYLEN = 32;

/**
 * 密码哈希（scrypt，随机盐）：`scrypt$<salt>$<hash>`。
 * 从旧 db.ts 提取到 service 层，供 AuthService 注入使用。
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${SCRYPT_PREFIX}${salt}$${hash}`;
}

/**
 * 校验密码。向后兼容旧版 sha256 哈希（无 `scrypt$` 前缀时按旧格式校验）。
 * @param legacySalt 旧版静态 salt（jwtSecret），仅用于旧哈希。
 */
export function verifyPassword(password: string, stored: string, legacySalt: string): boolean {
  if (stored.startsWith(SCRYPT_PREFIX)) {
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
  return hashPasswordLegacy(password, legacySalt) === stored;
}

function hashPasswordLegacy(password: string, salt: string): string {
  return createHash('sha256').update(`${salt}${password}`).digest('hex');
}
