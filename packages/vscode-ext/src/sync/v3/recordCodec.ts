import { openAes256Gcm, sealAes256Gcm, type SealedBox } from '../crypto/aead';
import { jcs } from '../crypto/jcs';
import { DatabaseType } from '@db-client/core';
import { databaseEngineOf } from '../entitlementGate';
import type { SavedConnection } from '../../connection/connectionStore';

/**
 * record 密文编解码（B3a，§8.1.1/8.1.5/8.1.8）。
 *
 * - 白名单严格关闭对象：只把下面列出的字段放进明文 record；`id`、`createTime`/
 *   `updateTime`/`deleted` 由服务端 record 行管理，`dbPath`/`sshPrivateKeyPath` 及
 *   一切本机路径、OS keychain、组织引用一律不入明文。
 * - `sqliteCommand` 可能间接携带本地路径/启动参数，在语义与校验规则明确前**刻意
 *   不在白名单**（后续单独裁定）。后果（B4 UI 义务）：拉回的 SQLite 连接无文件
 *   路径，设备 B 须由用户补数据库路径后方可连接。
 * - `dbType` 的 engine 归一（'MYSQL'→'mysql' 等）归 B3b，本层原样透传。
 * - record AAD.purpose 恒为 'record'（写死，不接受外部传参）。
 */

export const RECORD_PAYLOAD_FIELDS = [
  'name', 'dbType', 'host', 'port', 'user', 'password', 'database', 'schema',
  'timezone', 'groupId', 'environment', 'readOnly', 'useSSL',
  'sshHost', 'sshPort', 'sshUser', 'sshPassword', 'sshPassphrase',
] as const;

export interface RecordAadCtx {
  userId: string;
  keyEpoch: string;
  recordId: string;
  recordVersion: string;
}

/** 白名单严格关闭对象：仅列内字段，剔除 undefined。URI/命令类字段 fail-closed。 */
export function encodeRecordPayload(conn: SavedConnection): Record<string, unknown> {
  if (conn.useConnectionString) throw new Error('V3 sync does not support useConnectionString');
  if (conn.connectionUrl) throw new Error('V3 sync does not support connectionUrl');
  if (conn.sqliteCommand) throw new Error('V3 sync does not support sqliteCommand');
  const src = conn as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of RECORD_PAYLOAD_FIELDS) {
    if (k === 'dbType') { out[k] = databaseEngineOf(conn.dbType); continue; }
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const ENGINE_TO_DB_TYPE: Record<string, DatabaseType> = {
  mysql: DatabaseType.MYSQL,
  postgresql: DatabaseType.PG,
  sqlite: DatabaseType.SQLITE,
};

/** payload 的 engine 字符串 → DatabaseType（未知引擎 fail-closed）。 */
export function databaseTypeFromEngine(engine: string): DatabaseType {
  const t = ENGINE_TO_DB_TYPE[engine];
  if (!t) throw new Error(`unknown database engine: ${engine}`);
  return t;
}

/** record AAD 对象（§8.1.8）。purpose 恒为 'record'，写死。 */
export function recordAad(ctx: RecordAadCtx): Record<string, unknown> {
  return {
    userId: ctx.userId,
    keyEpoch: ctx.keyEpoch,
    recordId: ctx.recordId,
    recordVersion: ctx.recordVersion,
    protocolVersion: 1,
    cipherSuite: 'AES-256-GCM',
    formatVersion: 1,
    purpose: 'record',
  };
}

/** record AAD 规范化字节（JCS → UTF-8），供 AEAD。 */
export function recordAadBytes(ctx: RecordAadCtx): Uint8Array {
  return new Uint8Array(Buffer.from(jcs(recordAad(ctx)), 'utf8'));
}

/** record 加密（key=DEK）。nonce 12B 由调用方提供（B3b 负责唯一）。 */
export function sealRecord(dek: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, ctx: RecordAadCtx): SealedBox {
  return sealAes256Gcm(dek, nonce, plaintext, recordAadBytes(ctx));
}

/** record 解密（key=DEK）。tag/密文被篡改或 key 不符时抛错。 */
export function openRecord(dek: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array, ctx: RecordAadCtx): Uint8Array {
  return openAes256Gcm(dek, nonce, ciphertext, tag, recordAadBytes(ctx));
}