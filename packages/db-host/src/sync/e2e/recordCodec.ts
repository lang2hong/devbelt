import { openAes256Gcm, sealAes256Gcm, type SealedBox } from '../crypto/aead.js';
import { jcs } from '../crypto/jcs.js';
import { DatabaseType, databaseEngineOf, databaseTypeFromEngine } from '@devbelt/db-core';

export { databaseTypeFromEngine } from '@devbelt/db-core';

import type { SavedConnection } from '../../connection/connectionStore.js';
import type { ConnectionGroup } from '../../connection/connectionStore.js';
import type { QueryFolder } from '../../connection/queryStore.js';
import type { SavedQuery } from '@devbelt/db-core';
import { assertSyncEntityType, type SyncEntityType } from './syncEntity.js';
import {
  assertAuthenticatorAlgorithm, assertAuthenticatorDigits, assertAuthenticatorPeriod,
  assertAuthenticatorSecret, assertAuthenticatorTagColor,
  type AuthenticatorAlgorithm, type AuthenticatorTagColor,
  type SyncAuthenticatorEntryValue, type SyncAuthenticatorGroup, type SyncAuthenticatorTag,
} from './authenticatorTypes.js';
import { assertBusinessRules, assertSchemaNotesScope, assertSchemaNotesTables, type SyncBusinessRules, type SyncSchemaNotesValue } from './schemaNotesTypes.js';
import { assertAiModelAccessPayload, type AiModelAccessPayload, type SyncAiModelAccessValue } from './aiModelAccessTypes.js';

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

/** Redis 引擎白名单字段（P7 字段 + 共用 TLS/SSH）。 */
export const REDIS_PAYLOAD_FIELDS = [
  'name', 'dbType', 'host', 'port', 'user', 'password',
  'useSSL', 'rejectUnauthorized', 'redisDb', 'keySeparator', 'redisMode',
  'sentinelName', 'clusterNodes', 'sentinelNodes', 'sentinelPassword',
  'color', 'environment', 'readOnly',
  'sshHost', 'sshPort', 'sshUser', 'sshPassword', 'sshPassphrase',
] as const;

/** Elasticsearch 引擎白名单字段（S7l.1 接入同步；认证/TLS 与共用 SSH 字段同 MySQL/Redis 模式）。 */
export const ES_PAYLOAD_FIELDS = [
  'name', 'dbType', 'host', 'port',
  'esProtocol', 'esPathPrefix', 'esAuth', 'esPassword', 'esApiKey',
  'useSSL', 'rejectUnauthorized', 'requestTimeout',
  'color', 'environment', 'readOnly',
  'sshHost', 'sshPort', 'sshUser', 'sshPassword', 'sshPassphrase',
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

/**
 * 该引擎的连接里真正参与同步的字段（引擎白名单 + 路径字段）。
 * 不在此集合内的本地字段（如 MySQL/PG 的 color、连接/请求超时）是「本机独有」，
 * 远端版本落地时必须保留，不能被整条覆盖丢掉。
 */
export function syncedConnectionFields(dbType: DatabaseType): readonly string[] {
  return [...payloadFieldsFor(dbType), ...CONNECTION_PATH_FIELDS];
}

function payloadFieldsFor(dbType: DatabaseType): readonly string[] {
  if (dbType === DatabaseType.SQLITE) return SQLITE_PAYLOAD_FIELDS;
  if (dbType === DatabaseType.REDIS) return REDIS_PAYLOAD_FIELDS;
  if (dbType === DatabaseType.ELASTICSEARCH) return ES_PAYLOAD_FIELDS;
  return MYSQL_PG_PAYLOAD_FIELDS;
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
  | { type: 'query'; entity: SavedQuery }
  | { type: 'authenticatorGroup'; entity: SyncAuthenticatorGroup }
  | { type: 'authenticatorTag'; entity: SyncAuthenticatorTag }
  | { type: 'authenticatorEntry'; entity: SyncAuthenticatorEntryValue }
  | { type: 'schemaNotes'; entity: SyncSchemaNotesValue }
  | { type: 'aiModelAccess'; entity: SyncAiModelAccessValue };

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

/** 编码「验证器分组」payload：name + sortOrder（无引用）。 */
export function encodeAuthenticatorGroupPayload(group: SyncAuthenticatorGroup): Record<string, unknown> {
  return { type: 'authenticatorGroup', name: group.name, sortOrder: group.sortOrder };
}

/** 编码「验证器标签」payload：name + color（白名单）。 */
export function encodeAuthenticatorTagPayload(tag: SyncAuthenticatorTag): Record<string, unknown> {
  return { type: 'authenticatorTag', name: tag.name, color: assertAuthenticatorTagColor(tag.color) };
}

/**
 * 编码「验证器条目」payload：issuer/account/算法/位数/周期/时间戳 + secret（规范化 base32）
 * + groupId（group recordId 引用）+ tags[]（tag recordId 引用）。
 * `localOnly`/`syncError` 为仅本地派生态，**不编码**。未解析的引用（groupId/tags）省略。
 */
export function encodeAuthenticatorEntryPayload(entity: SyncAuthenticatorEntryValue, resolveRef: RefResolver): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: 'authenticatorEntry',
    issuer: entity.issuer,
    algorithm: assertAuthenticatorAlgorithm(entity.algorithm),
    digits: assertAuthenticatorDigits(entity.digits),
    period: assertAuthenticatorPeriod(entity.period),
    createTime: entity.createTime,
    updateTime: entity.updateTime,
  };
  if (entity.account !== undefined) out.account = entity.account;
  out.secret = assertAuthenticatorSecret(entity.secret);
  const groupRecordId = resolveRef('authenticatorGroup', entity.groupId);
  if (groupRecordId !== undefined) out.groupId = groupRecordId;
  const tagRecordIds: string[] = [];
  for (const tagLocalId of entity.tags) {
    const rec = resolveRef('authenticatorTag', tagLocalId);
    if (rec !== undefined) tagRecordIds.push(rec);
  }
  if (tagRecordIds.length > 0) out.tags = tagRecordIds;
  return out;
}

/** 按类型分派编码。 */
export function encodeEntityPayload(input: CodecEntityInput, resolveRef: RefResolver): Record<string, unknown> {
  switch (input.type) {
    case 'connection': return encodeConnectionPayload(input.entity, resolveRef);
    case 'group': return encodeGroupPayload(input.entity, resolveRef);
    case 'queryFolder': return encodeQueryFolderPayload(input.entity, resolveRef);
    case 'query': return encodeQueryPayload(input.entity, resolveRef);
    case 'authenticatorGroup': return encodeAuthenticatorGroupPayload(input.entity);
    case 'authenticatorTag': return encodeAuthenticatorTagPayload(input.entity);
    case 'authenticatorEntry': return encodeAuthenticatorEntryPayload(input.entity, resolveRef);
    case 'schemaNotes': return encodeSchemaNotesPayload(input.entity, resolveRef);
    case 'aiModelAccess': return encodeAiModelAccessPayload(input.entity);
  }
}

/** AI 模型接入配置编码：仅含后端已按本机勾选裁剪的组；此处做白名单校验。 */
export function encodeAiModelAccessPayload(entity: SyncAiModelAccessValue): Record<string, unknown> {
  const payload = assertAiModelAccessPayload({
    ...(entity.selection ? { selection: entity.selection } : {}),
    ...(entity.custom ? { custom: entity.custom } : {}),
    ...(entity.apiKey ? { apiKey: entity.apiKey } : {}),
  });
  return { type: 'aiModelAccess', ...payload };
}

/** 解码：各组可选（发送端未勾选的组不出现在 payload）。 */
export function decodeAiModelAccessPayload(p: Record<string, unknown>): AiModelAccessPayload {
  return assertAiModelAccessPayload(p);
}

/** S7f 编码：connId 本地 id → recordId（unresolved 时省略字段，后续轮收敛）。 */
export function encodeSchemaNotesPayload(entity: SyncSchemaNotesValue, resolveRef: RefResolver): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: 'schemaNotes',
    scope: assertSchemaNotesScope(entity.scope),
    tables: assertSchemaNotesTables(entity.tables),
    ...(entity.businessRules ? { businessRules: assertBusinessRules(entity.businessRules) } : {}),
  };
  const connRecordId = resolveRef('connection', entity.connId);
  if (connRecordId !== undefined) out.connId = connRecordId;
  return out;
}

/** S7f 解码：connId（recordId）可选（unresolved）；scope/tables 必填并校验。 */
export interface DecodedSchemaNotesPayload {
  connId?: string;
  scope: string;
  tables: Record<string, unknown>;
  businessRules?: SyncBusinessRules;
}

export function decodeSchemaNotesPayload(p: Record<string, unknown>): DecodedSchemaNotesPayload {
  const connId = p.connId;
  if (connId !== undefined && typeof connId !== 'string') throw new Error('schemaNotes.connId must be a string');
  return {
    ...(typeof connId === 'string' && connId ? { connId } : {}),
    scope: assertSchemaNotesScope(p.scope),
    tables: assertSchemaNotesTables(p.tables),
    ...(p.businessRules !== undefined ? { businessRules: assertBusinessRules(p.businessRules) } : {}),
  };
}

/**
 * 兼容旧 API：仅连接的单实体编码（无 groupId 解析时返回空 resolver）。
 * 保留用于示例/迁移；新代码请用 encodeEntityPayload。
 */
export function encodeRecordPayload(conn: SavedConnection, resolveRef?: RefResolver): Record<string, unknown> {
  return encodeConnectionPayload(conn, resolveRef ?? (() => undefined));
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

/** Redis 解码结果：host/port 必需；cluster/sentinel 追加节点列表。 */
export interface DecodedRedisPayload {
  dbType: DatabaseType.REDIS;
  name: string;
  host: string;
  port: number;
  user?: string;
  password?: string;
  useSSL?: boolean;
  rejectUnauthorized?: boolean;
  redisDb?: number;
  keySeparator?: string;
  redisMode?: 'standalone' | 'cluster' | 'sentinel';
  sentinelName?: string;
  clusterNodes?: string;
  sentinelNodes?: string;
  sentinelPassword?: string;
  color?: string;
  environment?: 'development' | 'test' | 'staging' | 'production';
  readOnly?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  sshPassphrase?: string;
  caPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  sshPrivateKeyPath?: string;
  socketPath?: string;
  /** 引用的分组 sync recordId（应用层转本地 id）。 */
  groupId?: string;
}

export type DecodedConnectionPayload = DecodedMysqlPgPayload | DecodedSqlitePayload | DecodedRedisPayload | DecodedEsPayload;

/** ES 解码结果（S7l.1）：host/port 必需；认证对象 esAuth 严格校验 kind。 */
export interface DecodedEsPayload {
  dbType: DatabaseType.ELASTICSEARCH;
  name: string;
  host: string;
  port: number;
  esProtocol?: 'http' | 'https';
  esPathPrefix?: string;
  esAuth?: { kind: 'none' } | { kind: 'basic'; username: string } | { kind: 'apiKey' };
  esPassword?: string;
  esApiKey?: string;
  useSSL?: boolean;
  rejectUnauthorized?: boolean;
  requestTimeout?: number;
  color?: string;
  environment?: 'development' | 'test' | 'staging' | 'production';
  readOnly?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  sshPassphrase?: string;
  caPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  sshPrivateKeyPath?: string;
  groupId?: string;
}

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

export interface DecodedAuthenticatorGroupPayload {
  name: string;
  sortOrder: number;
}

export interface DecodedAuthenticatorTagPayload {
  name: string;
  color: AuthenticatorTagColor;
}

export interface DecodedAuthenticatorEntryPayload {
  issuer: string;
  account?: string;
  algorithm: AuthenticatorAlgorithm;
  digits: 6 | 8;
  period: 30 | 60;
  secret: string;
  groupId?: string;
  tags?: string[];
  createTime: number;
  updateTime: number;
}

export type DecodedEntityPayload =
  | { type: 'connection'; data: DecodedConnectionPayload }
  | { type: 'group'; data: DecodedGroupPayload }
  | { type: 'queryFolder'; data: DecodedQueryFolderPayload }
  | { type: 'query'; data: DecodedQueryPayload }
  | { type: 'authenticatorGroup'; data: DecodedAuthenticatorGroupPayload }
  | { type: 'authenticatorTag'; data: DecodedAuthenticatorTagPayload }
  | { type: 'authenticatorEntry'; data: DecodedAuthenticatorEntryPayload }
  | { type: 'schemaNotes'; data: DecodedSchemaNotesPayload }
  | { type: 'aiModelAccess'; data: AiModelAccessPayload };

/**
 * 向前兼容策略（D14）：**忽略未知字段**，只校验已知字段。
 *
 * 新版本给 payload 增字段时，旧客户端若严格拒绝就会整页失败、入站同步卡住（同 H3）。
 * payload 在 AEAD 密文内且 AAD 绑定，未知字段无法在不知 DEK 的情况下注入，故忽略是安全的；
 * 敏感字段仍只经加密通道、且由已知字段校验约束。已知字段的缺失/类型/取值仍 fail-closed。
 */
function ignoreUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) delete obj[k];
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

function strArrayOf(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`record payload.${key} must be a string array`);
  return v as string[];
}

function nonNegIntOf(obj: Record<string, unknown>, key: string): number | undefined {
  const v = intOf(obj, key);
  if (v === undefined) return undefined;
  if (v < 0) throw new Error(`record payload.${key} must be >= 0`);
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
  ignoreUnknownKeys(obj, [...payloadFieldsFor(dbType), ...CONNECTION_PATH_FIELDS, 'type', 'groupId']);

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

  if (dbType === DatabaseType.ELASTICSEARCH) {
    const esHost = strOf(obj, 'host');
    if (esHost === undefined) throw new Error('record payload.host is required');
    const esPort = uint16Of(obj, 'port');
    if (esPort === undefined) throw new Error('record payload.port is required');
    const esProtocol = strOf(obj, 'esProtocol');
    if (esProtocol !== undefined && esProtocol !== 'http' && esProtocol !== 'https') {
      throw new Error(`record payload.esProtocol invalid: ${esProtocol}`);
    }
    const rawAuth = obj.esAuth;
    let esAuth: DecodedEsPayload['esAuth'];
    if (rawAuth !== undefined) {
      if (typeof rawAuth !== 'object' || rawAuth === null) throw new Error('record payload.esAuth invalid');
      const a = rawAuth as Record<string, unknown>;
      if (a.kind === 'none') esAuth = { kind: 'none' };
      else if (a.kind === 'basic') {
        const username = typeof a.username === 'string' ? a.username : undefined;
        if (username === undefined) throw new Error('record payload.esAuth.username is required');
        esAuth = { kind: 'basic', username };
      } else if (a.kind === 'apiKey') esAuth = { kind: 'apiKey' };
      else throw new Error(`record payload.esAuth.kind invalid: ${String(a.kind)}`);
    }
    const requestTimeout = nonNegIntOf(obj, 'requestTimeout');
    if (requestTimeout !== undefined && requestTimeout > 600_000) {
      throw new Error(`record payload.requestTimeout out of range: ${requestTimeout}`);
    }
    return {
      dbType, name, host: esHost, port: esPort,
      esProtocol: esProtocol as DecodedEsPayload['esProtocol'],
      esPathPrefix: strOf(obj, 'esPathPrefix'),
      esAuth,
      esPassword: strOf(obj, 'esPassword'),
      esApiKey: strOf(obj, 'esApiKey'),
      useSSL: boolOf(obj, 'useSSL'),
      rejectUnauthorized: boolOf(obj, 'rejectUnauthorized'),
      requestTimeout,
      color: strOf(obj, 'color'),
      environment: env as DecodedEsPayload['environment'],
      readOnly,
      sshHost: strOf(obj, 'sshHost'),
      sshPort: uint16Of(obj, 'sshPort'),
      sshUser: strOf(obj, 'sshUser'),
      sshPassword: strOf(obj, 'sshPassword'),
      sshPassphrase: strOf(obj, 'sshPassphrase'),
      caPath: strOf(obj, 'caPath'),
      clientCertPath: strOf(obj, 'clientCertPath'),
      clientKeyPath: strOf(obj, 'clientKeyPath'),
      sshPrivateKeyPath: strOf(obj, 'sshPrivateKeyPath'),
      groupId,
    };
  }

  if (dbType === DatabaseType.REDIS) {
    const redisMode = strOf(obj, 'redisMode');
    if (redisMode !== undefined && !['standalone', 'cluster', 'sentinel'].includes(redisMode)) {
      throw new Error(`record payload.redisMode invalid: ${redisMode}`);
    }
    const redisHost = strOf(obj, 'host');
    if (redisHost === undefined) throw new Error('record payload.host is required');
    const redisPort = uint16Of(obj, 'port');
    if (redisPort === undefined) throw new Error('record payload.port is required');
    return {
      dbType, name, host: redisHost, port: redisPort,
      user: strOf(obj, 'user'),
      password,
      useSSL: boolOf(obj, 'useSSL'),
      rejectUnauthorized: boolOf(obj, 'rejectUnauthorized'),
      redisDb: nonNegIntOf(obj, 'redisDb'),
      keySeparator: strOf(obj, 'keySeparator'),
      redisMode: redisMode as DecodedRedisPayload['redisMode'],
      sentinelName: strOf(obj, 'sentinelName'),
      clusterNodes: strOf(obj, 'clusterNodes'),
      sentinelNodes: strOf(obj, 'sentinelNodes'),
      sentinelPassword: strOf(obj, 'sentinelPassword'),
      color: strOf(obj, 'color'),
      environment: env as DecodedRedisPayload['environment'],
      readOnly,
      sshHost: strOf(obj, 'sshHost'),
      sshPort: uint16Of(obj, 'sshPort'),
      sshUser: strOf(obj, 'sshUser'),
      sshPassword: strOf(obj, 'sshPassword'),
      sshPassphrase: strOf(obj, 'sshPassphrase'),
      caPath: strOf(obj, 'caPath'),
      clientCertPath: strOf(obj, 'clientCertPath'),
      clientKeyPath: strOf(obj, 'clientKeyPath'),
      sshPrivateKeyPath: strOf(obj, 'sshPrivateKeyPath'),
      socketPath: strOf(obj, 'socketPath'),
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
  ignoreUnknownKeys(obj, GROUP_PAYLOAD_FIELDS);
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
  ignoreUnknownKeys(obj, FOLDER_PAYLOAD_FIELDS);
  const name = strOf(obj, 'name');
  if (name === undefined) throw new Error('record payload.name is required');
  const connId = strOf(obj, 'connId');
  return { name, connId };
}

function decodeQueryPayload(p: unknown): DecodedQueryPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const obj = p as Record<string, unknown>;
  if (obj.type !== 'query') throw new Error('record payload.type must be query');
  ignoreUnknownKeys(obj, QUERY_PAYLOAD_FIELDS);
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

const AUTH_GROUP_PAYLOAD_FIELDS = ['type', 'name', 'sortOrder'] as const;
const AUTH_TAG_PAYLOAD_FIELDS = ['type', 'name', 'color'] as const;
const AUTH_ENTRY_PAYLOAD_FIELDS = [
  'type', 'issuer', 'account', 'algorithm', 'digits', 'period', 'secret', 'groupId', 'tags', 'createTime', 'updateTime',
] as const;

function decodeAuthenticatorGroupPayload(p: unknown): DecodedAuthenticatorGroupPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const obj = p as Record<string, unknown>;
  if (obj.type !== 'authenticatorGroup') throw new Error('record payload.type must be authenticatorGroup');
  ignoreUnknownKeys(obj, AUTH_GROUP_PAYLOAD_FIELDS);
  const name = strOf(obj, 'name');
  if (name === undefined) throw new Error('record payload.name is required');
  const sortOrder = nonNegIntOf(obj, 'sortOrder');
  if (sortOrder === undefined) throw new Error('record payload.sortOrder is required');
  return { name, sortOrder };
}

function decodeAuthenticatorTagPayload(p: unknown): DecodedAuthenticatorTagPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const obj = p as Record<string, unknown>;
  if (obj.type !== 'authenticatorTag') throw new Error('record payload.type must be authenticatorTag');
  ignoreUnknownKeys(obj, AUTH_TAG_PAYLOAD_FIELDS);
  const name = strOf(obj, 'name');
  if (name === undefined) throw new Error('record payload.name is required');
  return { name, color: assertAuthenticatorTagColor(obj.color) };
}

function decodeAuthenticatorEntryPayload(p: unknown): DecodedAuthenticatorEntryPayload {
  if (typeof p !== 'object' || p === null) throw new Error('record payload must be an object');
  const obj = p as Record<string, unknown>;
  if (obj.type !== 'authenticatorEntry') throw new Error('record payload.type must be authenticatorEntry');
  ignoreUnknownKeys(obj, AUTH_ENTRY_PAYLOAD_FIELDS);
  const issuer = strOf(obj, 'issuer');
  if (issuer === undefined) throw new Error('record payload.issuer is required');
  const createTime = nonNegIntOf(obj, 'createTime');
  if (createTime === undefined) throw new Error('record payload.createTime is required');
  const updateTime = nonNegIntOf(obj, 'updateTime');
  if (updateTime === undefined) throw new Error('record payload.updateTime is required');
  return {
    issuer,
    account: strOf(obj, 'account'),
    algorithm: assertAuthenticatorAlgorithm(obj.algorithm),
    digits: assertAuthenticatorDigits(obj.digits),
    period: assertAuthenticatorPeriod(obj.period),
    secret: assertAuthenticatorSecret(obj.secret),
    groupId: strOf(obj, 'groupId'),
    tags: strArrayOf(obj, 'tags'),
    createTime,
    updateTime,
  };
}

/**
 * 严格解码 record 明文 payload → 已校验的判别结果。
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
    case 'authenticatorGroup': return { type: 'authenticatorGroup', data: decodeAuthenticatorGroupPayload(p) };
    case 'authenticatorTag': return { type: 'authenticatorTag', data: decodeAuthenticatorTagPayload(p) };
    case 'authenticatorEntry': return { type: 'authenticatorEntry', data: decodeAuthenticatorEntryPayload(p) };
    case 'schemaNotes': return { type: 'schemaNotes', data: decodeSchemaNotesPayload(p as Record<string, unknown>) };
    case 'aiModelAccess': return { type: 'aiModelAccess', data: decodeAiModelAccessPayload(p as Record<string, unknown>) };
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