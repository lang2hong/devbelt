import mysql from 'mysql2/promise';
import { buildMysqlPoolOptions } from '../mysqlPool.js';
import { resolveMysqlCreds } from '../mysqlCreds.js';
import type { MysqlDb } from '../repository/mysql/db.js';
import { MysqlUserRepo } from '../repository/mysql/userRepo.js';
import { MysqlAuditRepo } from '../repository/mysql/auditRepo.js';
import { AuditWriter } from '../service/auditWriter.js';

export interface AdminDeps {
  pool: mysql.Pool;
  userRepo: MysqlUserRepo;
  auditWriter: AuditWriter;
  close: () => Promise<void>;
}

/**
 * 独立脚本（提权 CLI）所需的最小装配：连接池 + userRepo + auditWriter。
 *
 * 与 `app.ts` 组合根共享 `resolveMysqlCreds`/`buildMysqlPoolOptions`，避免
 * 「如何连库、如何建 repo/audit」出现第二份实现；`close` 由调用方在 finally 调用。
 */
export function createAdminDeps(env: NodeJS.ProcessEnv): AdminDeps {
  const pool = mysql.createPool(buildMysqlPoolOptions(resolveMysqlCreds(env), env) as mysql.PoolOptions);
  const getMysql = (): MysqlDb => pool as unknown as MysqlDb;
  const userRepo = new MysqlUserRepo(getMysql);
  const auditWriter = new AuditWriter(new MysqlAuditRepo(getMysql), (msg, data) => console.warn(msg, data));
  return { pool, userRepo, auditWriter, close: () => pool.end() };
}