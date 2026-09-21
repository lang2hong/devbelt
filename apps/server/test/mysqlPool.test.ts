import { describe, it, expect } from 'vitest';
import { buildMysqlPoolOptions } from '../src/mysqlPool.js';

const creds = {
  host: 'db.example.com',
  port: 3306,
  user: 'dbclient',
  password: 'pw',
  database: 'devbelt_db',
};

describe('buildMysqlPoolOptions', () => {
  it('pins the pool defaults that silently break under load', () => {
    const o = buildMysqlPoolOptions(creds, {});
    // 这些值配错不会报错，只会在并发高峰表现为「全站卡死」。
    expect(o.waitForConnections).toBe(true);
    expect(o.connectionLimit).toBe(20);
    expect(o.queueLimit).toBe(100);
    expect(o.timezone).toBe('Z');
    expect(o.charset).toBe('utf8mb4_0900_ai_ci');
  });

  it('falls back to the default pool size on invalid DEVBELT_DB_MYSQL_POOL_SIZE', () => {
    for (const bad of ['0', '-1', 'abc', '']) {
      expect(buildMysqlPoolOptions(creds, { DEVBELT_DB_MYSQL_POOL_SIZE: bad }).connectionLimit).toBe(20);
    }
    expect(buildMysqlPoolOptions(creds, { DEVBELT_DB_MYSQL_POOL_SIZE: '35' }).connectionLimit).toBe(35);
  });

  it('never enables multipleStatements', () => {
    // 显式断言：一旦有人加上它，SQL 注入的影响面会从单语句放大到多语句。
    expect((buildMysqlPoolOptions(creds, {}) as unknown as Record<string, unknown>).multipleStatements).toBeUndefined();
  });
});

describe('MySQL TLS', () => {
  it('stays plaintext when no DEVBELT_DB_MYSQL_SSL* is configured', () => {
    expect(buildMysqlPoolOptions(creds, {}).ssl).toBeUndefined();
  });

  it('enables TLS with certificate verification by default', () => {
    const ssl = buildMysqlPoolOptions(creds, { DEVBELT_DB_MYSQL_SSL: 'true' }).ssl;
    expect(ssl).toBeDefined();
    expect(ssl?.rejectUnauthorized).toBe(true);
    expect(ssl?.ca).toBeUndefined();
  });

  it('treats an inline CA as implicit enablement', () => {
    const ssl = buildMysqlPoolOptions(creds, { DEVBELT_DB_MYSQL_SSL_CA: '-----BEGIN CERTIFICATE-----x' }).ssl;
    expect(ssl?.ca).toContain('BEGIN CERTIFICATE');
    expect(ssl?.rejectUnauthorized).toBe(true);
  });

  it('allows disabling verification only via an explicit false', () => {
    expect(
      buildMysqlPoolOptions(creds, { DEVBELT_DB_MYSQL_SSL: 'true', DEVBELT_DB_MYSQL_SSL_REJECT_UNAUTHORIZED: 'false' }).ssl
        ?.rejectUnauthorized,
    ).toBe(false);
    // 任何其它取值都不得放宽校验
    for (const v of ['', 'no', 'TRUE', 'yes', '1']) {
      expect(
        buildMysqlPoolOptions(creds, { DEVBELT_DB_MYSQL_SSL: 'true', DEVBELT_DB_MYSQL_SSL_REJECT_UNAUTHORIZED: v }).ssl
          ?.rejectUnauthorized,
      ).toBe(true);
    }
  });

  it('passes through servername for CN/SAN mismatches', () => {
    expect(
      buildMysqlPoolOptions(creds, { DEVBELT_DB_MYSQL_SSL: '1', DEVBELT_DB_MYSQL_SSL_SERVERNAME: 'real-host' }).ssl?.servername,
    ).toBe('real-host');
  });

  it('throws rather than silently downgrading when the CA file is unreadable', () => {
    // 静默降级会把「以为加密了」变成「其实没加密」，必须让启动失败。
    expect(() => buildMysqlPoolOptions(creds, { DEVBELT_DB_MYSQL_SSL_CA_FILE: '/nonexistent/ca.pem' })).toThrow();
  });
});
