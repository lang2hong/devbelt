import { describe, it, expect } from 'vitest';
import { redactUrl, buildLoggerOptions } from '../../src/middleware/requestLogging.js';

describe('redactUrl', () => {
  it('redacts the email verification token path segment', () => {
    expect(redactUrl('/api/auth/email-verifications/abc123secret/confirm'))
      .toBe('/api/auth/email-verifications/[redacted]/confirm');
  });

  it('redacts the organization invitation token path segment', () => {
    expect(redactUrl('/api/organization-invitations/tok_ZmFrZS10b2tlbg/accept'))
      .toBe('/api/organization-invitations/[redacted]/accept');
  });

  it('redacts sensitive query parameters case-insensitively', () => {
    expect(redactUrl('/sync-reset?token=secret')).toBe('/sync-reset?token=[redacted]');
    expect(redactUrl('/x?Token=secret&page=2')).toBe('/x?Token=[redacted]&page=2');
    expect(redactUrl('/x?refreshToken=secret')).toBe('/x?refreshToken=[redacted]');
    expect(redactUrl('/x?recoveryCode=secret')).toBe('/x?recoveryCode=[redacted]');
  });

  it('leaves ordinary paths and non-sensitive query parameters untouched', () => {
    expect(redactUrl('/api/organizations/12/members')).toBe('/api/organizations/12/members');
    expect(redactUrl('/api/sync/records?limit=100&cursor=abc')).toBe('/api/sync/records?limit=100&cursor=abc');
    expect(redactUrl('/health')).toBe('/health');
  });

  it('drops the fragment and still redacts the path token', () => {
    expect(redactUrl('/api/organization-invitations/secret/accept#frag'))
      .toBe('/api/organization-invitations/[redacted]/accept');
  });

  it('handles empty and malformed input without throwing', () => {
    expect(redactUrl('')).toBe('');
    // 空 query 折叠掉尾部 '?'：日志里没有信息损失。
    expect(redactUrl('/x?')).toBe('/x');
    expect(redactUrl('/x?=nokey')).toBe('/x?=nokey');
  });
});

describe('buildLoggerOptions', () => {
  it('serializes requests without headers/body and with a redacted url', () => {
    const serializer = buildLoggerOptions().serializers.req;
    const serialized = serializer({
      method: 'POST',
      url: '/api/auth/email-verifications/leak-me/confirm',
      ip: '203.0.113.7',
      headers: { authorization: 'Bearer super-secret' },
      body: { password: 'super-secret' },
    }) as Record<string, unknown>;

    expect(serialized).toEqual({
      method: 'POST',
      url: '/api/auth/email-verifications/[redacted]/confirm',
      remoteAddress: '203.0.113.7',
    });
    expect(JSON.stringify(serialized)).not.toContain('leak-me');
    expect(JSON.stringify(serialized)).not.toContain('super-secret');
  });
});

describe('error serializer (mysql2 SQL must never reach logs)', () => {
  const serialize = () => buildLoggerOptions().serializers.err;

  it('strips the interpolated sql/sqlMessage from driver errors', () => {
    // mysql2 把参数已内联的完整语句挂在 err.sql 上；pino 默认序列化器会原样带出。
    const err = Object.assign(new Error("Data too long for column 'bucket_key'"), {
      code: 'ER_DATA_TOO_LONG',
      errno: 1406,
      sqlState: '22001',
      sql: "INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'argon2id$m=65536,t=3,p=1$SALT$SECRETHASH')",
      sqlMessage: "Data too long for column 'bucket_key' at row 1",
    });

    const out = serialize()(err) as Record<string, unknown>;
    const json = JSON.stringify(out);

    expect(json).not.toContain('SECRETHASH');
    expect(json).not.toContain('a@b.c');
    expect(json).not.toContain('INSERT INTO');
    expect(out.sql).toBeUndefined();
    expect(out.sqlMessage).toBeUndefined();
    // 诊断码仍需保留，否则线上无法判因
    expect(out.code).toBe('ER_DATA_TOO_LONG');
    expect(out.errno).toBe(1406);
    expect(out.sqlState).toBe('22001');
  });

  it('keeps message and stack for ordinary (non-driver) errors', () => {
    const err = new Error('plain failure');
    const out = serialize()(err) as Record<string, unknown>;
    expect(out.message).toBe('plain failure');
    expect(typeof out.stack).toBe('string');
  });

  it('drops row-bearing structures and non-scalar extras', () => {
    const err = Object.assign(new Error('x'), {
      code: 'ER_X',
      errno: 1,
      rows: [{ token_hash: 'LEAK' }],
      fields: [{ name: 'token_hash' }],
      parameters: ['LEAK2'],
    });
    const json = JSON.stringify(serialize()(err));
    expect(json).not.toContain('LEAK');
    expect(json).not.toContain('LEAK2');
  });
});
