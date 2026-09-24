import { openCipherRecord, type CipherRecord } from '@devbelt/auth-client';

/**
 * P6-S5c：验证器页纯逻辑（无 Vue/无 DOM，便于单测）。
 * 负责「解密后的 record payload → 展示行」的筛选/映射，以及 feed 的分页收集。
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
