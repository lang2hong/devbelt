import { decodeBase64Url } from '../crypto/recoveryCode';
import {
  ARGON2ID_ITERATIONS_MAX,
  ARGON2ID_ITERATIONS_MIN,
  ARGON2ID_MEMORY_MAX_KIB,
  ARGON2ID_MEMORY_MIN_KIB,
  ARGON2ID_PARALLELISM_MAX,
  ARGON2ID_PARALLELISM_MIN,
} from '../crypto/smpKdfParams';

/**
 * 个人同步协议 DTO 类型与编码校验。
 *
 * u64（keyEpoch/stateVersion/baseVersion/envelopeVersion/after/snapshotSequence）
 * 十进制字符串、无符号、无前导零、≤ 2^64-1；0 仅在该字段协议允许时接受。base64url
 * 严格为**无 padding**（拒绝 `=`/`+`/`/`/空）。validator 返回「冻结纯 JSON」——
 * 显式字段构造的普通对象，不含 undefined/函数/bigint/toJSON，保证 JCS 与
 * JSON.stringify 请求体逐字节一致。
 */

export const U64_MAX = '18446744073709551615';

export interface SmpKdfDto {
  alg: 'argon2id';
  version: 1;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: string;
  outputBytes: 32;
}

export interface RecoveryKdfDto {
  alg: 'hkdf-sha256';
  version: 1;
  salt: string;
  outputBytes: 32;
}

export interface EnvelopeDto {
  protocolVersion: 1;
  cipherSuite: 'AES-256-GCM';
  formatVersion: 1;
  envelopeVersion: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface NewStateDto {
  protocolVersion: 1;
  cipherSuite: 'AES-256-GCM';
  formatVersion: 1;
  smpKdf: SmpKdfDto;
  recoveryKdf: RecoveryKdfDto;
  envelopeSmp: EnvelopeDto;
  envelopeRecovery: EnvelopeDto;
  envelopeAccount: EnvelopeDto;
  accountRecoveryKey: string;
  signPub: string;
  recoverSignPub: string;
}

function rejectExtraKeys(obj: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`${field} has unexpected key "${k}"`);
  }
}

export { rejectExtraKeys };

/** u64 十进制字符串：无符号、无前导零、≤ 2^64-1；0 仅在 allowZero 时接受。 */
export function assertU64Decimal(s: string, field: string, allowZero = false): string {
  if (allowZero && s === '0') return s;
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error(`${field} must be an unsigned decimal integer with no leading zeros`);
  }
  if (s.length > U64_MAX.length || (s.length === U64_MAX.length && s > U64_MAX)) {
    throw new Error(`${field} exceeds u64 max ${U64_MAX}`);
  }
  return s;
}

/** 无 padding base64url 严格校验（拒绝 `=`/`+`/`/`/空），并校验解码长度。 */
export function assertBase64UrlNoPad(s: string, lenBytes: number, field: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new Error(`${field} must be unpadded base64url`);
  }
  const bytes = decodeBase64Url(s);
  if (bytes.length !== lenBytes) {
    throw new Error(`${field} must decode to ${lenBytes} bytes (got ${bytes.length})`);
  }
  return bytes;
}

/** 无 padding base64url 严格校验（拒绝 `=`/`+`/`/`/空），并校验解码长度落在 [minBytes, maxBytes]。 */
export function assertBase64UrlRange(s: string, minBytes: number, maxBytes: number, field: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new Error(`${field} must be unpadded base64url`);
  }
  const bytes = decodeBase64Url(s);
  if (bytes.length < minBytes || bytes.length > maxBytes) {
    throw new Error(`${field} must decode to ${minBytes}..${maxBytes} bytes (got ${bytes.length})`);
  }
  return bytes;
}

/** recordId：无语义随机 base64url，解码 1‥128 字节（§7.1 接受口径）。 */
export function assertRecordId(s: string, field = 'recordId'): string {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error(`${field} must be unpadded base64url`);
  const bytes = decodeBase64Url(s);
  if (bytes.length < 1 || bytes.length > 128) {
    throw new Error(`${field} must decode to 1..128 bytes (got ${bytes.length})`);
  }
  return s;
}

export function validateSmpKdf(k: unknown): SmpKdfDto {
  if (typeof k !== 'object' || k === null) throw new Error('smpKdf must be an object');
  const obj = k as Record<string, unknown>;
  rejectExtraKeys(obj, ['alg', 'version', 'memoryKiB', 'iterations', 'parallelism', 'salt', 'outputBytes'], 'smpKdf');
  if (obj.alg !== 'argon2id') throw new Error(`smpKdf.alg must be argon2id`);
  if (obj.version !== 1) throw new Error('smpKdf.version must be 1');
  if (!Number.isSafeInteger(obj.memoryKiB) || (obj.memoryKiB as number) < ARGON2ID_MEMORY_MIN_KIB || (obj.memoryKiB as number) > ARGON2ID_MEMORY_MAX_KIB) {
    throw new Error(`smpKdf.memoryKiB out of range [${ARGON2ID_MEMORY_MIN_KIB}, ${ARGON2ID_MEMORY_MAX_KIB}]`);
  }
  if (!Number.isSafeInteger(obj.iterations) || (obj.iterations as number) < ARGON2ID_ITERATIONS_MIN || (obj.iterations as number) > ARGON2ID_ITERATIONS_MAX) {
    throw new Error(`smpKdf.iterations out of range [${ARGON2ID_ITERATIONS_MIN}, ${ARGON2ID_ITERATIONS_MAX}]`);
  }
  if (!Number.isSafeInteger(obj.parallelism) || (obj.parallelism as number) < ARGON2ID_PARALLELISM_MIN || (obj.parallelism as number) > ARGON2ID_PARALLELISM_MAX) {
    throw new Error(`smpKdf.parallelism out of range [${ARGON2ID_PARALLELISM_MIN}, ${ARGON2ID_PARALLELISM_MAX}]`);
  }
  if (typeof obj.salt !== 'string') throw new Error('smpKdf.salt must be a string');
  assertBase64UrlNoPad(obj.salt, 16, 'smpKdf.salt');
  if (obj.outputBytes !== 32) throw new Error('smpKdf.outputBytes must be 32');
  return {
    alg: 'argon2id', version: 1,
    memoryKiB: obj.memoryKiB as number, iterations: obj.iterations as number, parallelism: obj.parallelism as number,
    salt: obj.salt, outputBytes: 32,
  };
}

export function validateRecoveryKdf(k: unknown): RecoveryKdfDto {
  if (typeof k !== 'object' || k === null) throw new Error('recoveryKdf must be an object');
  const obj = k as Record<string, unknown>;
  rejectExtraKeys(obj, ['alg', 'version', 'salt', 'outputBytes'], 'recoveryKdf');
  if (obj.alg !== 'hkdf-sha256') throw new Error('recoveryKdf.alg must be hkdf-sha256');
  if (obj.version !== 1) throw new Error('recoveryKdf.version must be 1');
  if (typeof obj.salt !== 'string') throw new Error('recoveryKdf.salt must be a string');
  assertBase64UrlNoPad(obj.salt, 16, 'recoveryKdf.salt');
  if (obj.outputBytes !== 32) throw new Error('recoveryKdf.outputBytes must be 32');
  return { alg: 'hkdf-sha256', version: 1, salt: obj.salt, outputBytes: 32 };
}

export function validateEnvelope(e: unknown, field: string): EnvelopeDto {
  if (typeof e !== 'object' || e === null) throw new Error(`${field} must be an object`);
  const obj = e as Record<string, unknown>;
  rejectExtraKeys(obj, ['protocolVersion', 'cipherSuite', 'formatVersion', 'envelopeVersion', 'nonce', 'ciphertext', 'tag'], field);
  if (obj.protocolVersion !== 1 || obj.cipherSuite !== 'AES-256-GCM' || obj.formatVersion !== 1) {
    throw new Error(`${field} protocol/cipher/format must be 1 / AES-256-GCM / 1`);
  }
  assertU64Decimal(obj.envelopeVersion as string, `${field}.envelopeVersion`);
  assertBase64UrlNoPad(obj.nonce as string, 12, `${field}.nonce`);
  if (typeof obj.ciphertext !== 'string') throw new Error(`${field}.ciphertext must be a string`);
  assertBase64UrlNoPad(obj.ciphertext, 32, `${field}.ciphertext`);
  assertBase64UrlNoPad(obj.tag as string, 16, `${field}.tag`);
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    envelopeVersion: obj.envelopeVersion as string,
    nonce: obj.nonce as string, ciphertext: obj.ciphertext as string, tag: obj.tag as string,
  };
}

export function validateNewState(ns: unknown): NewStateDto {
  if (typeof ns !== 'object' || ns === null) throw new Error('newState must be an object');
  const obj = ns as Record<string, unknown>;
  rejectExtraKeys(obj, ['protocolVersion', 'cipherSuite', 'formatVersion', 'smpKdf', 'recoveryKdf', 'envelopeSmp', 'envelopeRecovery', 'envelopeAccount', 'accountRecoveryKey', 'signPub', 'recoverSignPub'], 'newState');
  if (obj.protocolVersion !== 1 || obj.cipherSuite !== 'AES-256-GCM' || obj.formatVersion !== 1) {
    throw new Error('newState protocol/cipher/format must be 1 / AES-256-GCM / 1');
  }
  assertBase64UrlNoPad(obj.signPub as string, 32, 'newState.signPub');
  assertBase64UrlNoPad(obj.recoverSignPub as string, 32, 'newState.recoverSignPub');
  assertBase64UrlNoPad(obj.accountRecoveryKey as string, 32, 'newState.accountRecoveryKey');
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    smpKdf: validateSmpKdf(obj.smpKdf),
    recoveryKdf: validateRecoveryKdf(obj.recoveryKdf),
    envelopeSmp: validateEnvelope(obj.envelopeSmp, 'newState.envelopeSmp'),
    envelopeRecovery: validateEnvelope(obj.envelopeRecovery, 'newState.envelopeRecovery'),
    envelopeAccount: validateEnvelope(obj.envelopeAccount, 'newState.envelopeAccount'),
    accountRecoveryKey: obj.accountRecoveryKey as string,
    signPub: obj.signPub as string,
    recoverSignPub: obj.recoverSignPub as string,
  };
}

/** 服务端 GET /api/sync/state 的响应 DTO（对齐 server StateDto / toDto 输出）。 */
export interface StateDto {
  protocolVersion: 1;
  cipherSuite: 'AES-256-GCM';
  formatVersion: 1;
  keyEpoch: string;
  stateVersion: string;
  changeSequence: string;
  signPub: string;
  recoverSignPub: string;
  smpKdf: SmpKdfDto;
  recoveryKdf: RecoveryKdfDto;
  envelopeSmp: EnvelopeDto;
  envelopeRecovery: EnvelopeDto;
  /** 账号恢复通道版本号。必填：单一契约下恒存在（init 起 version 单调递增）。 */
  envelopeAccountVersion: string;
  recoveryCodeSetTime: string | null;
}

/** 校验服务端 sync state 响应（fail-closed）：全字段、未知字段拒绝、长度/base64url/KDF/envelope 严格。 */
export function validateSyncState(raw: unknown): StateDto {
  if (typeof raw !== 'object' || raw === null) throw new Error('sync state must be an object');
  const obj = raw as Record<string, unknown>;
  rejectExtraKeys(obj, [
    'protocolVersion', 'cipherSuite', 'formatVersion', 'keyEpoch', 'stateVersion', 'changeSequence',
    'signPub', 'recoverSignPub', 'smpKdf', 'recoveryKdf', 'envelopeSmp', 'envelopeRecovery',
    'envelopeAccountVersion', 'recoveryCodeSetTime',
  ], 'sync state');
  if (obj.protocolVersion !== 1 || obj.cipherSuite !== 'AES-256-GCM' || obj.formatVersion !== 1) {
    throw new Error('sync state protocol/cipher/format must be 1 / AES-256-GCM / 1');
  }
  const keyEpoch = obj.keyEpoch;
  const stateVersion = obj.stateVersion;
  const changeSequence = obj.changeSequence;
  if (typeof keyEpoch !== 'string' || typeof stateVersion !== 'string' || typeof changeSequence !== 'string') {
    throw new Error('sync state counters must be strings');
  }
  assertU64Decimal(keyEpoch, 'state.keyEpoch');
  assertU64Decimal(stateVersion, 'state.stateVersion');
  assertU64Decimal(changeSequence, 'state.changeSequence', true);
  assertBase64UrlNoPad(typeof obj.signPub === 'string' ? obj.signPub : '', 32, 'state.signPub');
  assertBase64UrlNoPad(typeof obj.recoverSignPub === 'string' ? obj.recoverSignPub : '', 32, 'state.recoverSignPub');
  if (obj.recoveryCodeSetTime !== null && typeof obj.recoveryCodeSetTime !== 'string') {
    throw new Error('state.recoveryCodeSetTime must be a string or null');
  }
  // 账号恢复通道为必填契约：envelopeAccountVersion 恒存在，缺失即拒绝（fail-closed），
  // 不再做「缺失 = 未启用」的兼容归一。
  if (typeof obj.envelopeAccountVersion !== 'string') throw new Error('state.envelopeAccountVersion must be a string');
  assertU64Decimal(obj.envelopeAccountVersion, 'state.envelopeAccountVersion');
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    keyEpoch, stateVersion, changeSequence,
    signPub: obj.signPub as string, recoverSignPub: obj.recoverSignPub as string,
    smpKdf: validateSmpKdf(obj.smpKdf),
    recoveryKdf: validateRecoveryKdf(obj.recoveryKdf),
    envelopeSmp: validateEnvelope(obj.envelopeSmp, 'state.envelopeSmp'),
    envelopeRecovery: validateEnvelope(obj.envelopeRecovery, 'state.envelopeRecovery'),
    envelopeAccountVersion: obj.envelopeAccountVersion,
    recoveryCodeSetTime: obj.recoveryCodeSetTime as string | null,
  };
}

/** POST /api/sync/recover-via-account 的响应 DTO（服务端托管账号恢复材料）。 */
export interface AccountRecoveryMaterialDto {
  accountRecoveryKey: string;
  envelopeAccount: EnvelopeDto;
}

/**
 * 校验服务端 recover-via-account 响应（fail-closed）：全字段、未知字段拒绝、
 * accountRecoveryKey 严格 32B base64url、envelopeAccount 走通用 envelope 校验。
 * 命令层/session 不得直接信任网络 DTO——此前 recoverByAccount() 曾在 open 前才因
 * base64url/长度错误抛出低层解码异常，未做统一的 fail-closed 前置校验。
 */
export function validateAccountRecoveryMaterial(raw: unknown): AccountRecoveryMaterialDto {
  if (typeof raw !== 'object' || raw === null) throw new Error('account recovery material must be an object');
  const obj = raw as Record<string, unknown>;
  rejectExtraKeys(obj, ['accountRecoveryKey', 'envelopeAccount'], 'account recovery material');
  if (typeof obj.accountRecoveryKey !== 'string') throw new Error('accountRecoveryKey must be a string');
  assertBase64UrlNoPad(obj.accountRecoveryKey, 32, 'accountRecoveryKey');
  return {
    accountRecoveryKey: obj.accountRecoveryKey,
    envelopeAccount: validateEnvelope(obj.envelopeAccount, 'envelopeAccount'),
  };
}
