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
