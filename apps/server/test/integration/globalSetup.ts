import mysql from 'mysql2/promise';
import { parseMysqlUrl, resolveTestDb } from './testDb.js';

/**
 * 集成测试 globalSetup：在每次 `vitest run --project integration` 开始时清空
 * DEVBELT_DB_TEST_MYSQL_DB 的全部表（`SET FOREIGN_KEY_CHECKS = 0` + DROP），消除
 * 「需先手动清库」的隐式前提（否则固定邮箱在唯一键上会残留导致重跑失败）。
 *
 * 缺 DEVBELT_DB_TEST_MYSQL_URL 时直接返回 —— 集成测试用 `describe.skipIf(!URL)` 跳过。
 * 只作用于 resolveTestDb() 判定的测试库，拒绝误指生产库由 resolveTestDb 保证。
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.DEVBELT_DB_TEST_MYSQL_URL;
  if (!url) return;

  const { host, port, user, password } = parseMysqlUrl(url);
  const dbName = resolveTestDb();
  const conn = await mysql.createConnection({ host, port, user, password, database: dbName });
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const [rows] = await conn.query('SHOW TABLES');
    for (const r of rows as Array<Record<string, unknown>>) {
      const table = String(Object.values(r)[0]);
      await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await conn.end();
  }
}