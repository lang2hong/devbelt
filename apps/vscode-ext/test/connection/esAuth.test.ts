import { describe, expect, it } from 'vitest';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { esAuthMissingMessage, esAuthOf, esProtocolOf, esTlsOf } from '../../src/connection/esAuth';

function conn(over: Partial<SavedConnection>): SavedConnection {
  return { id: 'c1', name: 'ES', dbType: 'ELASTICSEARCH' as SavedConnection['dbType'], host: 'h', port: 9200, user: '', ...over };
}

describe('esAuthOf（P8；空用户名 Basic 归一为 none）', () => {
  it('basic + 用户名 → basic（密码带入）', () => {
    expect(esAuthOf(conn({ esAuth: { kind: 'basic', username: 'elastic' }, esPassword: 'p' }))).toEqual({ kind: 'basic', username: 'elastic', password: 'p' });
  });

  it('basic + 空/空白用户名 → none（避免 `Basic ":"` 误导性 401）', () => {
    expect(esAuthOf(conn({ esAuth: { kind: 'basic', username: '' } }))).toEqual({ kind: 'none' });
    expect(esAuthOf(conn({ esAuth: { kind: 'basic', username: '   ' } }))).toEqual({ kind: 'none' });
  });

  it('用户名两侧空白被裁剪', () => {
    expect(esAuthOf(conn({ esAuth: { kind: 'basic', username: ' elastic ' } }))).toMatchObject({ kind: 'basic', username: 'elastic' });
  });

  it('apiKey / 缺省', () => {
    expect(esAuthOf(conn({ esAuth: { kind: 'apiKey' }, esApiKey: 'k' }))).toEqual({ kind: 'apiKey', apiKey: 'k' });
    expect(esAuthOf(conn({}))).toEqual({ kind: 'none' });
  });
});

describe('esProtocolOf / esTlsOf', () => {
  it('协议白名单（默认 http）', () => {
    expect(esProtocolOf(conn({ esProtocol: 'https' }))).toBe('https');
    expect(esProtocolOf(conn({}))).toBe('http');
  });

  it('TLS 仅在 useSSL 时携带', () => {
    expect(esTlsOf(conn({}))).toBeUndefined();
    expect(esTlsOf(conn({ useSSL: true, caPath: '/ca.pem', rejectUnauthorized: false }))).toMatchObject({ caPath: '/ca.pem', rejectUnauthorized: false });
  });
});
describe('esAuthMissingMessage（未配置认证的 401 提示判定）', () => {
  it('未配置认证 + 认证类错误 → true（含 unable to authenticate / missing credentials / 401）', () => {
    expect(esAuthMissingMessage('missing authentication credentials for REST request [/]', 'none')).toBe(true);
    expect(esAuthMissingMessage('unable to authenticate user [] for REST request [/]', 'none')).toBe(true);
    expect(esAuthMissingMessage('HTTP 401', 'none')).toBe(true);
  });

  it('已配置认证 或 非认证错误 → false', () => {
    expect(esAuthMissingMessage('missing authentication credentials', 'basic')).toBe(false);
    expect(esAuthMissingMessage('missing authentication credentials', 'apiKey')).toBe(false);
    expect(esAuthMissingMessage('connect ECONNREFUSED', 'none')).toBe(false);
  });
});
