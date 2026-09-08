import type { Migration } from '../migrate.js';

/**
 * 浏览器控制台会话（P3 切片 2）schema。
 *
 * `users.session_version`：改密 / 禁用用户时 +1，使所有存量 access token 立即失效
 * （§4.1）。守卫式 ALTER：查 information_schema，已存在则跳过（兼容旧账本重跑与 DDL
 * 隐式提交的部分执行，见 009 同款处理）。
 */
export const consoleSessionMigration: Migration = {
  version: '013_console_session',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    const [columnRows] = (await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
         AND COLUMN_NAME = 'session_version'`,
    )) as [Array<{ COLUMN_NAME: string }>, unknown];

    if (columnRows.length === 0) {
      await db.query(`ALTER TABLE users ADD COLUMN session_version INT UNSIGNED NOT NULL DEFAULT 0`);
    }
  },
};