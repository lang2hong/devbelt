import { describe, expect, it } from 'vitest';
import { resolveMysqlCreds } from '../../src/mysqlCreds.js';

describe('resolveMysqlCreds 空密码 fail-fast', () => {
  it('本地 + 空密码：放行', () => {
    expect(resolveMysqlCreds({ MYSQL_HOST: '127.0.0.1' }).password).toBe('');
    expect(resolveMysqlCreds({}).password).toBe('');
  });

  it('远程 + 空密码：拒绝启动', () => {
    expect(() => resolveMysqlCreds({ MYSQL_HOST: 'db.prod.example.com' })).toThrow(/MYSQL_PASSWORD is empty/);
  });

  it('远程 + 空密码 + MYSQL_ALLOW_EMPTY_PASSWORD=1：显式放行', () => {
    expect(resolveMysqlCreds({ MYSQL_HOST: 'db.prod.example.com', MYSQL_ALLOW_EMPTY_PASSWORD: '1' }).password).toBe('');
  });

  it('远程 + 有密码：放行', () => {
    expect(resolveMysqlCreds({ MYSQL_HOST: 'db.prod.example.com', MYSQL_PASSWORD: 's3cret' }).password).toBe('s3cret');
  });
});