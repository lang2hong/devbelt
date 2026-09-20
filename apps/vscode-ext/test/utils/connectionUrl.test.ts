import { describe, expect, it } from 'vitest';
import { hasUrlCredentials, stripUrlCredentials } from '../../src/utils/connectionUrl';

describe('connectionUrl 凭据处理', () => {
  it('识别内嵌凭据', () => {
    expect(hasUrlCredentials('mysql://user:secret@host:3306/db')).toBe(true);
    expect(hasUrlCredentials('mysql://user@host/db')).toBe(true);
    expect(hasUrlCredentials('mysql://host:3306/db')).toBe(false);
  });

  it('剥离密码但保留用户名与其余部分', () => {
    const out = stripUrlCredentials('mysql://user:secret@host:3306/db?ssl=true');
    expect(out).not.toContain('secret');
    expect(out).toContain('user@host:3306');
    expect(out).toContain('ssl=true');
  });

  it('无凭据时原样返回', () => {
    const url = 'postgres://host:5432/db';
    expect(stripUrlCredentials(url)).toBe(url);
  });

  it('解析失败时原样返回，避免改坏相对/非法串', () => {
    expect(stripUrlCredentials('not a url')).toBe('not a url');
    expect(hasUrlCredentials('not a url')).toBe(false);
  });

  it('识别并脱敏 libpq 关键词 DSN 的 password=', () => {
    const dsn = 'host=h port=5432 user=u password=p dbname=d';
    expect(hasUrlCredentials(dsn)).toBe(true);
    const out = stripUrlCredentials(dsn);
    expect(out).not.toContain('password=p');
    expect(out).toContain('password=***');
  });

  it('识别并脱敏 JDBC 的 user:pass@', () => {
    const jdbc = 'jdbc:mysql://user:pass@host:3306/db';
    expect(hasUrlCredentials(jdbc)).toBe(true);
    const out = stripUrlCredentials(jdbc);
    expect(out).not.toContain('pass');
    expect(out).toContain('jdbc:mysql://user@host:3306/db');
  });
});