/**
 * Elasticsearch 连接配置 → EsClient 认证/TLS 参数（P8 S2）。
 *
 * 单一映射入口：连接表单的「测试连接」与会话装配（`buildEsSession`）共用，
 * 避免两处各写一份 auth/protocol 解析而漂移。
 */
import type { EsAuth, EsClientOptions, EsProtocol } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';

/** 协议归一（缺省 http）。 */
export function esProtocolOf(conn: SavedConnection): EsProtocol {
  return conn.esProtocol === 'https' ? 'https' : 'http';
}

/** 认证归一：none/basic(username+esPassword)/apiKey(esApiKey)；Basic 空用户名按未配置处理。 */
export function esAuthOf(conn: SavedConnection): EsAuth {
  const auth = conn.esAuth;
  if (auth?.kind === 'basic') {
    const username = auth.username?.trim();
    if (!username) return { kind: 'none' };
    return { kind: 'basic', username, password: conn.esPassword };
  }
  if (auth?.kind === 'apiKey') return { kind: 'apiKey', apiKey: conn.esApiKey };
  return { kind: 'none' };
}

/** TLS 参数（仅 https 且配置了证书/自签开关时携带）。 */
export function esTlsOf(conn: SavedConnection): EsClientOptions['tls'] {
  if (!conn.useSSL) return undefined;
  return {
    caPath: conn.caPath,
    clientCertPath: conn.clientCertPath,
    clientKeyPath: conn.clientKeyPath,
    rejectUnauthorized: conn.rejectUnauthorized,
  };
}

/** 401/认证类错误且连接未配置任何认证 → 调用方应追加「去编辑连接」的可操作提示。 */
const ES_AUTH_ERROR_RE = /401|unauthorized|authentication credentials|unable to authenticate/i;

export function esAuthMissingMessage(message: string, authKind: 'none' | 'basic' | 'apiKey'): boolean {
  return authKind === 'none' && ES_AUTH_ERROR_RE.test(message);
}
