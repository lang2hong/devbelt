import { openAes256Gcm, sealAes256Gcm, type SealedBox } from '../crypto/aead.js';
import { jcs } from '../crypto/jcs.js';
import { DatabaseType } from '@devkit/db-core';
import { databaseEngineOf } from '../entitlementGate.js';
import type { SavedConnection } from '../../connection/connectionStore.js';
import type { ConnectionGroup } from '../../connection/connectionStore.js';
import type { QueryFolder } from '../../connection/queryStore.js';
import type { SavedQuery } from '@devkit/db-core';
import { assertSyncEntityType, type SyncEntityType } from './syncEntity.js';

/**
 * record 密文编解码（A2：四类型 discriminated payload + 引用转 recordId）。
 *
 * - 每种 payload 首字段 `type` 判别：`connection | group | queryFolder | query`。
 * - 引用字段一律存 **sync recordId**（不是本地 id）：group.parentId、queryFolder.connId、
 *   query.connId/folderId、connection.groupId。编码时本地 id 经调用方注入的 resolver
 *   转 recordId；目标无 recordId（未到达/pending）时保留 unresolved（§D3 / N4），不归根。
 * - 连接按引擎白名单（MySQL/PG 允许 host/port/user/schema/useSSL/ssh*；SQLite 仅
 *   name/dbType+password/database/timezone/environment/readOnly），SQLite 引擎专属字段
 *   非空即 fail-closed。本机路径字段（D1 源配置）现在**同步**：dbPath/caPath/clientCertPath/
 *   clientKeyPath/sshPrivateKeyPath/socketPath/connectionUrl/useConnectionString/sqliteCommand。
 *   敏感路径/URL 只进密文，绝不进日志/错误详情。
 * - query.sql 编码前按 UTF-8 字节长度校验 ≤ 64 KiB，超限 fail-closed（N8）。
 * - `dbType` 归一为 engine 字符串，解码还原 DatabaseType，未知 fail-closed。
 * - record AAD.purpose 恒为 'record'。
 */

export const MYSQL_PG_PAYLOAD_FIELDS = [
  'name', 'dbType', 'host', 'port', 'user', 'password', 'database', 'schema',
  'timezone', 'environment', 'readOnly', 'useSSL',
  'sshHost', 'sshPort', 'sshUser', 'sshPassword', 'sshPassphrase',
] as const;

export const SQLITE_PAYLOAD_FIELDS = [
  'name', 'dbType', 'password', 'database', 'timezone', 'environment', 'readOnly',
] as const;

/** D1：跨设备同步的路径/URL/命令字段（源配置；敏感，仅入密文）。 */
export const CONNECTION_PATH_FIELDS = [
  'dbPath', 'caPath', 'clientCertPath', 'clientKeyPath', 'sshPrivateKeyPath',
  'socketPath', 'connectionUrl', 'useConnectionString', 'sqliteCommand',
] as const;

/** SQLite 严禁出现的引擎专属字段（编码时非空即抛错）。 */
const SQLITE_FORBIDDEN_FIELDS = [
  'host', 'port', 'user', 'schema', 'useSSL',
  'sshHost', 'sshPort', 'sshUser', 'sshPassword', 'sshPassphrase',
] as const;

export const SQL_MAX_BYTES = 64 * 1024;

function payloadFieldsFor(dbType: DatabaseType): readonly string[] {
  return dbType === DatabaseType.SQLITE ? SQLITE_PAYLOAD_FIELDS : MYSQL_PG_PAYLOAD_FIELDS;
}

/** 空值判据：undefined/空串/0/false 视为「未设置」，SQLite 引擎专属字段据此豁免。 */
function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === 0 || v === false;
}

/** 本地 id → sync recordId 的解析器（encode 用）；返回 undefined 表示 unresolved。 */
export type RefResolver = (type: SyncEntityType, localId: string | undefined) => string | undefined;

export interface RecordAadCtx {
  userId: string;
  keyEpoch: string;
  recordId: string;
  recordVersion: string;
}

export type CodecEntityInput =
  | { type: 'connection'; entity: SavedConnection }
  | { type: 'group'; entity: ConnectionGroup }
  | { type: 'queryFolder'; entity: QueryFolder }
  | { type: 'query'; entity: SavedQuery };

function assertSqlSize(sql: string): void {
  if (new TextEncoder().encode(sql).length > SQL_MAX_BYTES) {
    throw new Error('SQL content exceeds 64 KiB limit');
  }
}

/**
 * 编码「连接」payload：引擎白名单字段 + D1 路径字段 + groupId（recordId 引用）。
 * 返回带 `type:'connection'` 的判别对象。
 */
export function encodeConnectionPayload(conn: SavedConnection, resolveRef: RefResolver): Record<string, unknown> {
  const src = conn as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { type: 'connection', dbType: databaseEngineOf(conn.dbType) };

  if (conn.dbType === DatabaseType.SQLITE) {
    for (const k of SQLITE_FORBIDDEN_FIELDS) {
      if (!isBlank(src[k])) throw new Error(`sqlite sync payload must not contain ${k}`);
    }
  }
  for (const k of payloadFieldsFor(conn.dbType)) {
    if (k === 'dbType') continue;
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  for (const k of CONNECTION_PATH_FIELDS) {
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  const groupRecordId = resolveRef('group', conn.groupId);
  if (groupRecordId !== undefined) out.groupId = groupRecordId;
  return out;
}

/** 编码「分组」payload：name + parentId（recordId 引用，根为 undefined）。 */
export function encodeGroupPayload(group: ConnectionGroup, resolveRef: RefResolver): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'group', name: group.name };
  const parentRecordId = resolveRef('group', group.parentId);
  if (parentRecordId !== undefined) out.parentId = parentRecordId;
  return out;
}

/** 编码「查询文件夹」payload：name + connId（recordId 引用）。 */
export function encodeQueryFolderPayload(folder: QueryFolder, resolveRef: RefResolver): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'queryFolder', name: folder.name };
  const connRecordId = resolveRef('connection', folder.connId);
  if (connRecordId !== undefined) out.connId = connRecordId;
  return out;
}

/** 编码「查询」payload：name/sql/database + connId/folderId（recordId 引用）。 */
export function encodeQueryPayload(query: SavedQuery, resolveRef: RefResolver): Record<string, unknown> {
  assertSqlSize(query.sql);
  const out: Record<string, unknown> = { type: 'query', name: query.name, sql: query.sql };
  if (query.database !== undefined) out.database = query.database;
  const connRecordId = resolveRef('connection', query.connId);
  if (connRecordId !== undefined) out.connId = connRecordId;
  const folderRecordId = resolveRef('queryFolder', query.folderId);
  if (folderRecordId !== undefined) out.folderId = folderRecordId;
  return out;
}

/** 按类型分派编码。 */
export function encodeEntityPayload(input: CodecEntityInput, resolveRef: RefResolver): Record<string, unknown> {
  switch (input.type) {
    case 'connection': return encodeConnectionPayload(input.entity, resolveRef);
    case 'group': return encodeGroupPayload(input.entity, resolveRef);
    case 'queryFolder': return encodeQueryFolderPayload(input.entity, resolveRef);
    case 'query': return encodeQueryPayload(input.entity, resolveRef);
  }
}

/**
 * 兼容旧 API：仅连接的单实体编码（无 groupId 解析时返回空 resolver）。
 * 保留用于示例/迁移；新代码请用 encodeEntityPayload。
 */
export function encodeRecordPayload(conn: SavedConnection, resolveRef?: RefResolver): Record<string, unknown> {
  return encodeConnectionPayload(conn, resolveRef ?? (() => undefined));
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

/** MySQL/PostgreSQL 解码结果：host/port/user 必需。 */
export interface DecodedMysqlPgPayload {
  dbType: DatabaseType.MYSQL | DatabaseType.PG;
  name: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  database?: string;
  schema?: string;
  timezone?: string;
  environment?: 'development' | 'test' | 'staging' | 'production';
  readOnly?: boolean;
  useSSL?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  sshPassphrase?: string;
  dbPath?: string;
  caPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  sshPrivateKeyPath?: string;
  socketPath?: string;
  connectionUrl?: string;
  useConnectionString?: boolean;
  sqliteCommand?: string;
  /** 引用的分组 sync recordId（应用层转本地 id）。 */
  groupId?: string;
}

/** SQLite 解码结果：无 host/port/user（不走 TCP）。 */
export interface DecodedSqlitePayload {
  dbType: DatabaseType.SQLITE;
  name: string;
  password?: string;
  database?: string;
  timezone?: string;
  environment?: 'development' | 'test' | 'staging' | 'production';
  readOnly?: boolean;
  dbPath?: string;
  sqliteCommand?: string;
  connectionUrl?: string;
  useConnectionString?: boolean;
  /** 引用的分组 sync recordId（应用层转本地 id）。 */
  groupId?: string;
}

export type DecodedConnectionPayload = DecodedMysqlPgPayload | DecodedSqlitePayload;

/** 解码后的引用（recordId），应用层负责经 recordMap 转本地 id 并处理 unresolved。 */
export interface DecodedGroupPayload {
  name: string;
  parentId?: string;
}

export interface DecodedQueryFolderPayload {
  name: string;
  connId?: string;
}

export interface DecodedQueryPayload {
  name: string;
  sql: string;
  database?: string;
  connId?: string;
  folderId?: string;
}

export type DecodedEntityPayload =
  | { type: 'connection'; data: DecodedConnectionPayload }
  | { type: 'group'; data: DecodedGroupPayload }
  | { type: 'queryFolder'; data: DecodedQueryFolderPayload }
  | { type: 'query'; data: DecodedQueryPayload };

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

const GROUP_PAYLOAD_FIELDS = ['type', 'name', 'parentId'] as const;
const FOLDER_PAYLOAD_FIELDS = ['type', 'name', 'connId'] as const;
const QUERY_PAYLOAD_FIELDS = ['type', 'name', 'sql', 'database', 'connId', 'folderId'] as const;

function decodeConnectionPayload(p: unknown): DecodedConnectionPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const obj = p as Record<string, unknown>;
  if (obj.type !== 'connection') throw new Error('record payload.type must be connection');

  const dbTypeStr = strOf(obj, 'dbType');
  if (dbTypeStr === undefined) throw new Error('record payload.dbType is required');
  const dbType = databaseTypeFromEngine(dbTypeStr);
  rejectExtraKeys(obj, [...payloadFieldsFor(dbType), ...CONNECTION_PATH_FIELDS, 'type', 'groupId'], 'record payload');

  const name = strOf(obj, 'name');
  if (name === undefined) throw new Error('record payload.name is required');

  const env = strOf(obj, 'environment');
  if (env !== undefined && !['development', 'test', 'staging', 'production'].includes(env)) {
    throw new Error(`record payload.environment invalid: ${env}`);
  }

  const password = strOf(obj, 'password');
  const database = strOf(obj, 'database');
  const timezone = strOf(obj, 'timezone');
  const readOnly = boolOf(obj, 'readOnly');
  const groupId = strOf(obj, 'groupId');

  if (dbType === DatabaseType.SQLITE) {
    return {
      dbType, name, password, database, timezone,
      environment: env as DecodedSqlitePayload['environment'],
      readOnly,
      dbPath: strOf(obj, 'dbPath'),
      sqliteCommand: strOf(obj, 'sqliteCommand'),
      connectionUrl: strOf(obj, 'connectionUrl'),
      useConnectionString: boolOf(obj, 'useConnectionString'),
      groupId,
    };
  }

  const host = strOf(obj, 'host');
  if (host === undefined) throw new Error('record payload.host is required');
  const port = uint16Of(obj, 'port');
  if (port === undefined) throw new Error('record payload.port is required');
  const user = strOf(obj, 'user');
  if (user === undefined) throw new Error('record payload.user is required');

  return {
    dbType, name, host, port, user, password, database,
    schema: strOf(obj, 'schema'),
    timezone,
    environment: env as DecodedMysqlPgPayload['environment'],
    readOnly,
    useSSL: boolOf(obj, 'useSSL'),
    sshHost: strOf(obj, 'sshHost'),
    sshPort: uint16Of(obj, 'sshPort'),
    sshUser: strOf(obj, 'sshUser'),
    sshPassword: strOf(obj, 'sshPassword'),
    sshPassphrase: strOf(obj, 'sshPassphrase'),
    dbPath: strOf(obj, 'dbPath'),
    caPath: strOf(obj, 'caPath'),
    clientCertPath: strOf(obj, 'clientCertPath'),
    clientKeyPath: strOf(obj, 'clientKeyPath'),
    sshPrivateKeyPath: strOf(obj, 'sshPrivateKeyPath'),
    socketPath: strOf(obj, 'socketPath'),
    connectionUrl: strOf(obj, 'connectionUrl'),
    useConnectionString: boolOf(obj, 'useConnectionString'),
    sqliteCommand: strOf(obj, 'sqliteCommand'),
    groupId,
  };
}

function decodeGroupPayload(p: unknown): DecodedGroupPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const obj = p as Record<string, unknown>;
  if (obj.type !== 'group') throw new Error('record payload.type must be group');
  rejectExtraKeys(obj, GROUP_PAYLOAD_FIELDS, 'record payload');
  const name = strOf(obj, 'name');
  if (name === undefined) throw new Error('record payload.name is required');
  const parentId = strOf(obj, 'parentId');
  if (parentId === '') throw new Error('record payload.parentId must not be empty');
  return { name, parentId };
}

function decodeQueryFolderPayload(p: unknown): DecodedQueryFolderPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const obj = p as Record<string, unknown>;
  if (obj.type !== 'queryFolder') throw new Error('record payload.type must be queryFolder');
  rejectExtraKeys(obj, FOLDER_PAYLOAD_FIELDS, 'record payload');
  const name = strOf(obj, 'name');
  if (name === undefined) throw new Error('record payload.name is required');
  const connId = strOf(obj, 'connId');
  return { name, connId };
}

function decodeQueryPayload(p: unknown): DecodedQueryPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const obj = p as Record<string, unknown>;
  if (obj.type !== 'query') throw new Error('record payload.type must be query');
  rejectExtraKeys(obj, QUERY_PAYLOAD_FIELDS, 'record payload');
  const name = strOf(obj, 'name');
  if (name === undefined) throw new Error('record payload.name is required');
  const sql = strOf(obj, 'sql');
  if (sql === undefined) throw new Error('record payload.sql is required');
  assertSqlSize(sql);
  const database = strOf(obj, 'database');
  const connId = strOf(obj, 'connId');
  const folderId = strOf(obj, 'folderId');
  return { name, sql, database, connId, folderId };
}

/**
 * 严格解码 record 明文 payload → 已校验的四类型判别结果。
 * 引用字段保留 recordId，由 apply 层解析/保留 unresolved。
 * 旧式无 `type` 的 connection payload 视为非法（v2 强制类型判别）。
 */
export function decodeEntityPayload(p: unknown): DecodedEntityPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const type = assertSyncEntityType((p as Record<string, unknown>).type);
  switch (type) {
    case 'connection': return { type: 'connection', data: decodeConnectionPayload(p) };
    case 'group': return { type: 'group', data: decodeGroupPayload(p) };
    case 'queryFolder': return { type: 'queryFolder', data: decodeQueryFolderPayload(p) };
    case 'query': return { type: 'query', data: decodeQueryPayload(p) };
  }
}

/** 兼容旧 API：仅连接解码。 */
export function decodeRecordPayload(p: unknown): DecodedConnectionPayload {
  const r = decodeEntityPayload(p);
  if (r.type !== 'connection') throw new Error('record payload is not a connection');
  return r.data;
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