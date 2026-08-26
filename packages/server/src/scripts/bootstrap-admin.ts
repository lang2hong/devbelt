import { createPool } from 'mysql2/promise';
import { config } from '../config.js';
import { buildMysqlPoolOptions } from '../mysqlPool.js';
import { bootstrapInitialAdmin } from '../repository/mysql/bootstrapAdmin.js';
import type { MysqlDb } from '../repository/mysql/db.js';

/**
 * 仅用于全新 v2 数据库的首次管理员创建。
 *
 * 使用：
 * BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
 * BOOTSTRAP_ADMIN_PASSWORD='strong password' \
 * BOOTSTRAP_ADMIN_CONFIRM=CREATE \
 * pnpm --filter @db-client/server run bootstrap:admin
 */
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !password) throw new Error('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD are required');
if (process.env.BOOTSTRAP_ADMIN_CONFIRM !== 'CREATE') {
  throw new Error('set BOOTSTRAP_ADMIN_CONFIRM=CREATE to create the initial administrator');
}

const pool = createPool(buildMysqlPoolOptions(config.mysql, process.env));
try {
  const result = await bootstrapInitialAdmin(pool as unknown as MysqlDb, {
    email,
    password,
    displayName: process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
  });
  console.info(`initial administrator created (user=${result.userId}, organization=${result.organizationId})`);
} finally {
  await pool.end();
}
