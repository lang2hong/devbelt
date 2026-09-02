import { ResourceContentInvalidError } from '../domain/errors.js';
import type { ResourceType } from '../domain/enums.js';

/**
 * 资源 content 校验（§6.3）与 canonical JSON 计量（§6.2）。
 *
 * content 校验是**纯函数**（在业务事务外先做），不依赖订阅快照；
 * 引擎白名单（connection_template 的 databaseType 是否在订阅快照内）在
 * ResourceService 锁内按快照判定，返回 403 ORGANIZATION_FEATURE_REQUIRED。
 */

/** 递归字典序键排序 + 紧凑序列化（§6.2 canonical JSON）。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** canonical JSON 的 UTF-8 字节数（配额计量口径）。 */
export function canonicalJsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  }
  return value;
}

const FORBIDDEN_FIELD = /password|secret|credential|ssh|token|certificate|\bkey\b|path/i;

/** content 入口：先拒秘密字段，再按类型做闭合 schema 校验。 */
export function validateResourceContent(resourceType: ResourceType, content: unknown): void {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new ResourceContentInvalidError('content must be a JSON object');
  }
  const obj = content as Record<string, unknown>;
  assertNoSecretFields(obj);
  if (resourceType === 'connection_template') validateConnectionTemplate(obj);
  else validateQuery(obj);
}

/** 递归拒绝任何 password/secret/credential/ssh/certificate/key/token/path 字段名。 */
function assertNoSecretFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretFields(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_FIELD.test(key)) throw new ResourceContentInvalidError(`forbidden field: ${key}`);
      assertNoSecretFields(val);
    }
  }
}

function assertOnlyKeys(obj: Record<string, unknown>, allowed: string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!set.has(key)) throw new ResourceContentInvalidError(`unknown field: ${key}`);
  }
}

function str(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') throw new ResourceContentInvalidError('expected string');
  const s = value.trim();
  const len = Array.from(s).length;
  if (len < min || len > max) throw new ResourceContentInvalidError(`string length must be ${min}..${max}`);
  return value;
}

function validateConnectionTemplate(obj: Record<string, unknown>): void {
  assertOnlyKeys(obj, ['databaseType', 'host', 'port', 'database', 'username', 'ssl']);

  const databaseType = obj.databaseType;
  if (typeof databaseType !== 'string' || !databaseType.trim()) {
    throw new ResourceContentInvalidError('databaseType must be a non-blank string');
  }

  const host = obj.host;
  if (typeof host !== 'string' || !host.trim() || Array.from(host).length > 253) {
    throw new ResourceContentInvalidError('host must be a non-blank string (<= 253 chars)');
  }

  const port = obj.port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new ResourceContentInvalidError('port must be an integer 1..65535');
  }

  str(obj.database, 1, 128);

  if (obj.username !== undefined) str(obj.username, 1, 128);

  if (obj.ssl !== undefined) {
    if (obj.ssl === null || typeof obj.ssl !== 'object' || Array.isArray(obj.ssl)) {
      throw new ResourceContentInvalidError('ssl must be an object');
    }
    const ssl = obj.ssl as Record<string, unknown>;
    assertOnlyKeys(ssl, ['mode', 'rejectUnauthorized']);
    const mode = ssl.mode;
    if (mode !== 'disable' && mode !== 'require' && mode !== 'verify-ca' && mode !== 'verify-full') {
      throw new ResourceContentInvalidError('ssl.mode must be disable|require|verify-ca|verify-full');
    }
    if (ssl.rejectUnauthorized !== undefined && typeof ssl.rejectUnauthorized !== 'boolean') {
      throw new ResourceContentInvalidError('ssl.rejectUnauthorized must be boolean');
    }
  }
}

function validateQuery(obj: Record<string, unknown>): void {
  assertOnlyKeys(obj, ['sql', 'dialect']);

  const sql = obj.sql;
  if (typeof sql !== 'string' || !sql.trim() || Array.from(sql).length > 1_048_576) {
    throw new ResourceContentInvalidError('sql must be a non-blank string (<= 1048576 chars)');
  }

  if (obj.dialect !== undefined) {
    if (obj.dialect !== 'mysql' && obj.dialect !== 'postgresql' && obj.dialect !== 'sqlite') {
      throw new ResourceContentInvalidError('dialect must be mysql|postgresql|sqlite');
    }
  }
}