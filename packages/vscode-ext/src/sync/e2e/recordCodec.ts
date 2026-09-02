import { openAes256Gcm, sealAes256Gcm, type SealedBox } from '../crypto/aead';
import { jcs } from '../crypto/jcs';
import { DatabaseType } from '@db-client/core';
import { databaseEngineOf } from '../entitlementGate';
import type { SavedConnection } from '../../connection/connectionStore';

/**
 * record 密文编解码。
 *
 * - 白名单严格关闭对象：只把下面列出的字段放进明文 record；`id`、`createTime`/
 *   `updateTime`/`deleted` 由服务端 record 行管理，`dbPath`/`sshPrivateKeyPath` 及
 *   一切本机路径、OS keychain、组织引用一律不入明文。
 * - `sqliteCommand` 可能间接携带本地路径与启动参数，不在白名单。因此拉回的 SQLite
 *   连接没有文件路径，须由用户在本设备补齐数据库路径后才能连接。
 * - `dbType` 在本层归一为 engine 字符串（`databaseEngineOf`），解码时再还原为
 *   `DatabaseType`，未知 engine fail-closed。
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
  if (conn.useConnectionString) throw new Error('sync does not support useConnectionString');
  if (conn.connectionUrl) throw new Error('sync does not support connectionUrl');
  if (conn.sqliteCommand) throw new Error('sync does not support sqliteCommand');
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

export interface DecodedRecordPayload {
  name: string;
  dbType: DatabaseType;
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  schema?: string;
  timezone?: string;
  groupId?: string;
  environment?: 'development' | 'test' | 'staging' | 'production';
  readOnly?: boolean;
  useSSL?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

function rejectExtraKeys(obj: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`${field} has unexpected key "${k}"`);
  }
}

function strOf(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`record payload.${key} must be a string`);
  return v;
}

function intOf(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`record payload.${key} must be an integer`);
  return v;
}

function uint16Of(obj: Record<string, unknown>, key: string): number | undefined {
  const v = intOf(obj, key);
  if (v === undefined) return undefined;
  if (v < 0 || v > 65535) throw new Error(`record payload.${key} out of range 0..65535`);
  return v;
}

function boolOf(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`record payload.${key} must be a boolean`);
  return v;
}

/**
 * 严格解码 record 明文 payload → 已校验字段（§7.2）。
 *
 * 拒绝未知字段（additionalProperties:false）、类型错误、未知 engine、端口越界，并
 * 拒绝 `connectionUrl`/`useConnectionString`/`sqliteCommand`（这些早已不在白名单，
 * 出现即被 rejectExtraKeys 拒绝）。返回的是纯数据，不含 toJSON/getter/undefined。
 */
export function decodeRecordPayload(p: unknown): DecodedRecordPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const obj = p as Record<string, unknown>;
  rejectExtraKeys(obj, RECORD_PAYLOAD_FIELDS as readonly string[], 'record payload');

  const dbTypeStr = strOf(obj, 'dbType');
  if (dbTypeStr === undefined) throw new Error('record payload.dbType is required');
  const dbType = databaseTypeFromEngine(dbTypeStr);
  const name = strOf(obj, 'name');
  if (name === undefined) throw new Error('record payload.name is required');
  const host = strOf(obj, 'host');
  if (host === undefined) throw new Error('record payload.host is required');
  const port = uint16Of(obj, 'port');
  if (port === undefined) throw new Error('record payload.port is required');
  const user = strOf(obj, 'user');
  if (user === undefined) throw new Error('record payload.user is required');

  const env = strOf(obj, 'environment');
  if (env !== undefined && !['development', 'test', 'staging', 'production'].includes(env)) {
    throw new Error(`record payload.environment invalid: ${env}`);
  }

  return {
    name, dbType, host, port, user,
    password: strOf(obj, 'password'),
    database: strOf(obj, 'database'),
    schema: strOf(obj, 'schema'),
    timezone: strOf(obj, 'timezone'),
    groupId: strOf(obj, 'groupId'),
    environment: env as DecodedRecordPayload['environment'],
    readOnly: boolOf(obj, 'readOnly'),
    useSSL: boolOf(obj, 'useSSL'),
    sshHost: strOf(obj, 'sshHost'),
    sshPort: uint16Of(obj, 'sshPort'),
    sshUser: strOf(obj, 'sshUser'),
    sshPassword: strOf(obj, 'sshPassword'),
    sshPassphrase: strOf(obj, 'sshPassphrase'),
  };
}

/** record AAD 对象（§7.1）。purpose 恒为 'record'，写死。 */
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

/** record 加密（key=DEK）。nonce 12B 由调用方提供并保证唯一。 */
export function sealRecord(dek: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, ctx: RecordAadCtx): SealedBox {
  return sealAes256Gcm(dek, nonce, plaintext, recordAadBytes(ctx));
}

/** record 解密（key=DEK）。tag/密文被篡改或 key 不符时抛错。 */
export function openRecord(dek: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array, ctx: RecordAadCtx): Uint8Array {
  return openAes256Gcm(dek, nonce, ciphertext, tag, recordAadBytes(ctx));
}
