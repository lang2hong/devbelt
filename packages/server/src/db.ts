import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';

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

/**
 * 密码哈希（PBKDF2 风格）：使用服务端 salt + sha256。
 */
export function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(`${salt}${password}`).digest('hex');
}