import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * 数据库初始化：建库建表（幂等）。
 */
export async function initDatabase(app: FastifyInstance): Promise<void> {
  const mysql = app.mysql;
  // 创建数据库（若不存在）
  await mysql.query(
    `CREATE DATABASE IF NOT EXISTS \`${mysql.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await mysql.query(`USE \`${mysql.database}\``);

  // 用户表
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  // 同步数据表：一用户一行，存加密后的完整数据体
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS sync_data (
      user_id INT UNSIGNED PRIMARY KEY,
      data LONGTEXT NOT NULL,
      version INT UNSIGNED NOT NULL DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
}

const SCRYPT_PREFIX = 'scrypt$';
const SCRYPT_KEYLEN = 32;

/**
 * 密码哈希（scrypt，随机盐）：`scrypt$<salt>$<hash>`。
 * 相比旧版 sha256(静态salt+密码)，scrypt 为内存困难型 KDF，并带每用户随机盐。
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${SCRYPT_PREFIX}${salt}$${hash}`;
}

/**
 * 校验密码。向后兼容旧版 sha256 哈希（无 `scrypt$` 前缀时按旧格式校验）。
 * @param legacySalt 旧版使用的静态 salt（jwtSecret），仅用于旧哈希。
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
  // 旧版：sha256(legacySalt + password)
  return hashPasswordLegacy(password, legacySalt) === stored;
}

/** 旧版哈希（兼容已存在的用户）。 */
function hashPasswordLegacy(password: string, salt: string): string {
  return createHash('sha256').update(`${salt}${password}`).digest('hex');
}