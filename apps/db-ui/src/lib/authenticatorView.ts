import {
  openCipherRecord, importTotpKey, totpCodeForKey, totpSecondsLeft,
  type CipherRecord, type SmpKdfDto, type EnvelopeDto,
} from '@devbelt/auth-client';

/**
 * P6-S5c：验证器页纯逻辑（无 Vue/无 DOM 依赖，便于单测）。
 * 负责：解密后的 record payload → 展示行的筛选/映射、feed 分页收集、
 * 服务端 DTO 的 fail-closed 校验、以及带 CryptoKey 缓存的 TOTP 刷新。
 */

export type AuthAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';
export type AuthDigits = 6 | 8;
export type AuthPeriod = 30 | 60;

export interface AuthenticatorRow {
  recordId: string;
  issuer: string;
  account?: string;
  algorithm: AuthAlgorithm;
  digits: AuthDigits;
  period: AuthPeriod;
  secret: string;
  code: string;
  secondsLeft: number;
}

export interface FeedPage {
  records: CipherRecord[];
  nextAfter?: string;
}

export type FetchFeedPage = (after: string, limit: number) => Promise<FeedPage>;

export const DEFAULT_PAGE_SIZE = 256;
export const DEFAULT_MAX_PAGES = 50;

function asAlgorithm(v: unknown): AuthAlgorithm | undefined {
  return v === 'SHA1' || v === 'SHA256' || v === 'SHA512' ? v : undefined;
}

function asDigits(v: unknown): AuthDigits | undefined {
  return v === 6 || v === 8 ? v : undefined;
}

function asPeriod(v: unknown): AuthPeriod | undefined {
  return v === 30 || v === 60 ? v : undefined;
}

/**
 * 解密后的 payload → 展示行。
 * 非 `authenticatorEntry` 或字段非法（算法/位数/周期/secret）一律返回 undefined 丢弃，
 * 不把服务端密文内容当作可信输入。
 */
export function toAuthenticatorRow(recordId: string, payload: unknown): AuthenticatorRow | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'authenticatorEntry') return undefined;
  const algorithm = asAlgorithm(p.algorithm);
  const digits = asDigits(p.digits);
  const period = asPeriod(p.period);
  if (!algorithm || !digits || !period) return undefined;
  if (typeof p.secret !== 'string' || p.secret.length === 0) return undefined;
  const issuer = typeof p.issuer === 'string' ? p.issuer : '';
  const account = typeof p.account === 'string' ? p.account : undefined;
  return { recordId, issuer, account, algorithm, digits, period, secret: p.secret, code: '', secondsLeft: 0 };
}

/** 服务端 `smpKdf`（unknown）→ 严格 DTO；非法即抛错（fail-closed）。范围/盐长仍由 unlockDekBrowser 兜底。 */
export function toSmpKdfDto(raw: unknown): SmpKdfDto {
  if (typeof raw !== 'object' || raw === null) throw new Error('同步 KDF 参数不完整');
  const { alg, version, memoryKiB, iterations, parallelism, salt, outputBytes } = raw as Record<string, unknown>;
  if (alg !== 'argon2id' || version !== 1 || outputBytes !== 32 ||
      typeof memoryKiB !== 'number' || typeof iterations !== 'number' ||
      typeof parallelism !== 'number' || typeof salt !== 'string') {
    throw new Error('同步 KDF 参数不完整');
  }
  return { alg, version, memoryKiB, iterations, parallelism, salt, outputBytes };
}

/** 服务端 `envelopeSmp`（unknown）→ EnvelopeDto；字段缺失即抛错。 */
export function toEnvelopeDto(raw: unknown): EnvelopeDto {
  if (typeof raw !== 'object' || raw === null) throw new Error('同步信封字段不完整');
  const { envelopeVersion, nonce, ciphertext, tag } = raw as Record<string, unknown>;
  if (typeof envelopeVersion !== 'string' || !envelopeVersion ||
      typeof nonce !== 'string' || !nonce ||
      typeof ciphertext !== 'string' || !ciphertext ||
      typeof tag !== 'string' || !tag) {
    throw new Error('同步信封字段不完整');
  }
  return { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion, nonce, ciphertext, tag };
}

/**
 * 逐页拉取 feed 并解密，收集验证器条目（跳过墓碑与其它 entity kind）。
 * `truncated=true` 表示到达 `maxPages` 上限时仍有后续页，UI 应提示「仅显示部分」。
 */
export async function collectAuthenticatorRows(
  dek: Uint8Array,
  ctx: { userId: string; keyEpoch: string },
  fetchPage: FetchFeedPage,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<{ rows: AuthenticatorRow[]; truncated: boolean }> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const rows: AuthenticatorRow[] = [];
  let after = '0';
  for (let page = 0; page < maxPages; page++) {
    const { records, nextAfter } = await fetchPage(after, pageSize);
    for (const rec of records) {
      const payload = await openCipherRecord(dek, rec, ctx);
      const row = toAuthenticatorRow(rec.recordId, payload);
      if (row) rows.push(row);
    }
    if (!nextAfter) return { rows, truncated: false };
    after = nextAfter;
  }
  return { rows, truncated: true };
}

/** 每条记录的 TOTP 缓存：secret 变化（条目被更新）即失效重导，counter 未变则复用 code。 */
export interface TotpCacheEntry {
  secret: string;
  key: CryptoKey;
  counter: string;
  code: string;
}

export type TotpCache = Map<string, TotpCacheEntry>;

export function createTotpCache(): TotpCache {
  return new Map();
}

/**
 * 刷新展示行的 TOTP：每行都更新 `secondsLeft`；仅在周期翻转或 secret 变化时才做
 * `importKey` + `sign`，同周期内直接复用缓存 code。单项失败置 `'------'` 并清缓存。
 */
export async function refreshCodes(rows: AuthenticatorRow[], nowMs: number, cache: TotpCache): Promise<void> {
  for (const row of rows) {
    row.secondsLeft = totpSecondsLeft(nowMs, row.period);
    const counter = String(Math.floor(nowMs / 1000 / row.period));
    const entry = cache.get(row.recordId);
    if (entry && entry.secret === row.secret && entry.counter === counter) {
      row.code = entry.code;
      continue;
    }
    try {
      const key = entry && entry.secret === row.secret ? entry.key : await importTotpKey(row.secret, row.algorithm);
      const code = await totpCodeForKey(key, BigInt(counter), row.digits);
      cache.set(row.recordId, { secret: row.secret, key, counter, code });
      row.code = code;
    } catch {
      row.code = '------';
      cache.delete(row.recordId);
    }
  }
}


// ── 浏览器解锁缓存（localStorage）────────────────────────────────────────────
// 用户勾选「记住解锁」时把 DEK 存本地，30 天内免再输 SMP。安全口径见
// docs/P6-安全评审清单.md：DEK 不再「仅内存」，登出/锁定/切号/过期即清。

export const DEK_CACHE_KEY = 'devbelt.authenticator.dek';
export const DEK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface DekCacheEntry {
  dek: Uint8Array;
  userId: string;
  keyEpoch: string;
  exp: number;
}

function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeDekCache(e: DekCacheEntry): string {
  return JSON.stringify({ v: 1, dek: bytesToB64(e.dek), userId: e.userId, keyEpoch: e.keyEpoch, exp: e.exp });
}

/** 解析并校验缓存：版本/字段/时效（`exp > now`）/账号匹配/DEK 长度，任一不符返回 undefined。 */
export function decodeDekCache(raw: string | null | undefined, now: number, userId: string): DekCacheEntry | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as { v?: unknown; dek?: unknown; userId?: unknown; keyEpoch?: unknown; exp?: unknown };
    if (o.v !== 1 || typeof o.dek !== 'string' || typeof o.userId !== 'string' || typeof o.keyEpoch !== 'string' || typeof o.exp !== 'number') return undefined;
    if (o.userId !== userId || o.exp <= now) return undefined;
    const dek = b64ToBytes(o.dek);
    if (dek.length !== 32) return undefined;
    return { dek, userId: o.userId, keyEpoch: o.keyEpoch, exp: o.exp };
  } catch {
    return undefined;
  }
}
