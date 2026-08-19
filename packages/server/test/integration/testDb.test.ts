import { describe, expect, it } from 'vitest';
import { resolveTestDb, parseMysqlUrl } from './testDb.js';

/**
 * 门禁自身的测试。
 *
 * 这道门禁的作用是"配错变量时让测试起不来，而不是把 DDL 打到生产库"。
 * 它必须自己被验证 —— 一个坏掉的安全门比没有门更危险，因为它给人错觉。
 */
describe('resolveTestDb', () => {
  it('默认 dbclient_verify', () => {
    expect(resolveTestDb({})).toBe('dbclient_verify');
  });

  it('拒绝与 MYSQL_DATABASE 同名（最容易发生的误配）', () => {
    expect(() => resolveTestDb({ MYSQL_DATABASE: 'db_client', MYSQL_TEST_DB: 'db_client' }))
      .toThrow(/refusing/i);
    // 大小写不敏感：MySQL 在 Linux 上库名区分大小写，但人不会
    expect(() => resolveTestDb({ MYSQL_DATABASE: 'db_client', MYSQL_TEST_DB: 'DB_Client' }))
      .toThrow(/refusing/i);
  });

  it('拒绝名字里不含 verify/test 的库', () => {
    expect(() => resolveTestDb({ MYSQL_TEST_DB: 'production' })).toThrow(/refusing/i);
    expect(() => resolveTestDb({ MYSQL_TEST_DB: 'app' })).toThrow(/refusing/i);
  });

  it('接受带标识的库名', () => {
    expect(resolveTestDb({ MYSQL_TEST_DB: 'dbclient_verify' })).toBe('dbclient_verify');
    expect(resolveTestDb({ MYSQL_TEST_DB: 'ci_test' })).toBe('ci_test');
    expect(resolveTestDb({ MYSQL_TEST_DB: 'myTestDb' })).toBe('myTestDb');
  });

  it('生产库变量不影响一个合法的测试库名', () => {
    expect(resolveTestDb({ MYSQL_DATABASE: 'db_client', MYSQL_TEST_DB: 'dbclient_verify' }))
      .toBe('dbclient_verify');
  });

  it('空值拒绝而不是静默回落', () => {
    expect(() => resolveTestDb({ MYSQL_TEST_DB: '   ' })).toThrow(/empty/i);
  });
});

describe('parseMysqlUrl', () => {
  it('解析主机、端口与百分号编码的密码', () => {
    expect(parseMysqlUrl('mysql://u:p%40ss@h.example.com:3307')).toEqual({
      host: 'h.example.com', port: 3307, user: 'u', password: 'p@ss',
    });
  });

  it('省略端口时默认 3306', () => {
    expect(parseMysqlUrl('mysql://u:p@h').port).toBe(3306);
  });

  it('格式不对时抛错', () => {
    expect(() => parseMysqlUrl('postgres://u:p@h')).toThrow(/bad MYSQL_TEST_URL/);
  });
});
