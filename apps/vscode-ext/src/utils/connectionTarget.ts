import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';

/**
 * 影响已建会话/SSH 隧道的连接字段。不含 `name`/`groupId`/`color` 等纯展示字段，
 * 也不含密钥类字段（`password`/`sshPassword`/`sshPassphrase`/`sentinelPassword`——
 * 读取时机不确定，比不出可靠差异）。仅这些字段变化才需要关闭会话按新配置重连。
 */
export const CONNECTION_TARGET_FIELDS: readonly (keyof SavedConnection)[] = [
  'dbType', 'host', 'port', 'user', 'database', 'schema', 'timezone', 'socketPath', 'dbPath',
  'sqliteCommand', 'useConnectionString', 'connectionUrl', 'useSSL', 'rejectUnauthorized',
  'caPath', 'clientCertPath', 'clientKeyPath',
  'sshHost', 'sshPort', 'sshUser', 'sshPrivateKeyPath',
  'redisDb', 'keySeparator', 'redisMode', 'sentinelName', 'clusterNodes', 'sentinelNodes',
  'readOnly', 'environment', 'connectTimeout', 'requestTimeout',
];

/** 连接目标（会话/隧道相关）是否变化：用于编辑连接后决定是否关闭会话（H6）。 */
export function connectionTargetChanged(a: SavedConnection, b: SavedConnection): boolean {
  return CONNECTION_TARGET_FIELDS.some((k) => a[k] !== b[k]);
}