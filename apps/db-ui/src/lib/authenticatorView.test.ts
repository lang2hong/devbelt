import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@devbelt/auth-client', () => ({
  openCipherRecord: vi.fn(),
  importTotpKey: vi.fn(),
  totpCodeForKey: vi.fn(),
  totpSecondsLeft: vi.fn(),
}));

import { openCipherRecord, importTotpKey, totpCodeForKey, totpSecondsLeft } from '@devbelt/auth-client';
import {
  collectAuthenticator, collectAuthenticatorRows, createTotpCache, decodeDekCache, encodeDekCache, groupAuthenticator, refreshCodes, tagNameMap, toAuthenticatorGroup, toAuthenticatorRow, toAuthenticatorTag, toEnvelopeDto, toSmpKdfDto,
  DEK_CACHE_TTL_MS,
  type AuthenticatorGroup, type AuthenticatorRow,
} from './authenticatorView';

const rec = (recordId: string) => ({ recordId, version: '1', changeSequence: recordId, deleteTime: null });
const dek = new Uint8Array(32).fill(1);
const ctx = { userId: '7', keyEpoch: '1' };

function row(over: Partial<AuthenticatorRow> = {}): AuthenticatorRow {
  return { recordId: 'r1', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, secret: 'AAAA', code: '', secondsLeft: 0, ...over };
}

beforeEach(() => {
  vi.mocked(openCipherRecord).mockReset();
  vi.mocked(importTotpKey).mockReset();
  vi.mocked(importTotpKey).mockResolvedValue({} as CryptoKey);
  vi.mocked(totpCodeForKey).mockReset();
  vi.mocked(totpCodeForKey).mockResolvedValue('111111');
  vi.mocked(totpSecondsLeft).mockReset();
  vi.mocked(totpSecondsLeft).mockImplementation((nowMs: number, period: 30 | 60 = 30) => period - (Math.floor(nowMs / 1000) % period));
});

describe('toAuthenticatorRow', () => {
  it('maps a valid authenticatorEntry payload', () => {
    const r = toAuthenticatorRow('r1', {
      type: 'authenticatorEntry', issuer: 'Acme', account: 'a@b', algorithm: 'SHA256', digits: 8, period: 60, secret: 'ABCD',
    });
    expect(r).toMatchObject({
      recordId: 'r1', issuer: 'Acme', account: 'a@b', algorithm: 'SHA256', digits: 8, period: 60, secret: 'ABCD', code: '', secondsLeft: 0,
    });
  });

  it('rejects non-entry / malformed payloads', () => {
    expect(toAuthenticatorRow('r', { type: 'connection' })).toBeUndefined();
    expect(toAuthenticatorRow('r', { type: 'authenticatorEntry', algorithm: 'MD5', digits: 6, period: 30, secret: 'A' })).toBeUndefined();
    expect(toAuthenticatorRow('r', { type: 'authenticatorEntry', algorithm: 'SHA1', digits: 7, period: 30, secret: 'A' })).toBeUndefined();
    expect(toAuthenticatorRow('r', { type: 'authenticatorEntry', algorithm: 'SHA1', digits: 6, period: 45, secret: 'A' })).toBeUndefined();
    expect(toAuthenticatorRow('r', { type: 'authenticatorEntry', algorithm: 'SHA1', digits: 6, period: 30, secret: '' })).toBeUndefined();
    expect(toAuthenticatorRow('r', null)).toBeUndefined();
  });

  it('defaults a missing account and tolerates an empty issuer', () => {
    const r = toAuthenticatorRow('r', { type: 'authenticatorEntry', algorithm: 'SHA1', digits: 6, period: 30, secret: 'A' });
    expect(r).toMatchObject({ issuer: '', account: undefined });
  });
});

describe('toSmpKdfDto / toEnvelopeDto', () => {
  const kdf = { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'AAAA', outputBytes: 32 };
  const env = { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: 'n', ciphertext: 'c', tag: 't' };

  it('accepts well-formed server DTOs', () => {
    expect(toSmpKdfDto(kdf)).toEqual(kdf);
    expect(toEnvelopeDto(env)).toEqual(env);
  });

  it('fails closed on malformed server DTOs', () => {
    expect(() => toSmpKdfDto(null)).toThrow();
    expect(() => toSmpKdfDto({ ...kdf, alg: 'scrypt' })).toThrow();
    expect(() => toSmpKdfDto({ ...kdf, outputBytes: 64 })).toThrow();
    expect(() => toSmpKdfDto({ ...kdf, salt: undefined })).toThrow();
    expect(() => toEnvelopeDto({})).toThrow();
    expect(() => toEnvelopeDto({ ...env, nonce: '' })).toThrow();
    expect(() => toEnvelopeDto({ ...env, tag: undefined })).toThrow();
  });
});

describe('collectAuthenticatorRows', () => {
  it('collects entries across pages, skipping tombstones and other kinds', async () => {
    const payloads: Record<string, unknown> = {
      a: { type: 'authenticatorEntry', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, secret: 'AAAA' },
      b: { type: 'connection' },
      c: undefined,
    };
    vi.mocked(openCipherRecord).mockImplementation(async (_dek, r) => payloads[r.recordId]);
    const pages = [
      { records: [rec('a'), rec('b')], nextAfter: '2' },
      { records: [rec('c')] },
    ];
    let i = 0;
    const { rows, truncated } = await collectAuthenticatorRows(dek, ctx, async () => pages[i++]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recordId: 'a', issuer: 'A', code: '', secondsLeft: 0 });
    expect(truncated).toBe(false);
    expect(pages).toHaveLength(2);
  });

  it('stops without truncation when the feed has a single page', async () => {
    vi.mocked(openCipherRecord).mockResolvedValue({ type: 'authenticatorEntry', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, secret: 'AAAA' });
    const calls: string[] = [];
    const { rows, truncated } = await collectAuthenticatorRows(dek, ctx, async (after) => {
      calls.push(after);
      return { records: [rec('a')] };
    });
    expect(rows).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(calls).toEqual(['0']);
  });

  it('flags truncation when maxPages is exhausted', async () => {
    vi.mocked(openCipherRecord).mockResolvedValue({ type: 'authenticatorEntry', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, secret: 'AAAA' });
    const { truncated } = await collectAuthenticatorRows(
      dek, ctx,
      async (after) => ({ records: [rec(after)], nextAfter: String(Number(after) + 1) }),
      { maxPages: 3, pageSize: 1 },
    );
    expect(truncated).toBe(true);
  });
});

describe('refreshCodes', () => {
  it('reuses the imported key within a period and recomputes on rollover', async () => {
    const cache = createTotpCache();
    const rows = [row()];

    await refreshCodes(rows, 1_000, cache);
    expect(rows[0].code).toBe('111111');
    expect(importTotpKey).toHaveBeenCalledTimes(1);
    expect(totpCodeForKey).toHaveBeenCalledTimes(1);

    await refreshCodes(rows, 2_000, cache); // 同周期
    expect(importTotpKey).toHaveBeenCalledTimes(1);
    expect(totpCodeForKey).toHaveBeenCalledTimes(1);

    vi.mocked(totpCodeForKey).mockResolvedValue('222222');
    await refreshCodes(rows, 31_000, cache); // 跨周期，同一 secret → 复用 key
    expect(importTotpKey).toHaveBeenCalledTimes(1);
    expect(totpCodeForKey).toHaveBeenCalledTimes(2);
    expect(rows[0].code).toBe('222222');
    expect(rows[0].secondsLeft).toBe(29);
  });

  it('re-imports when the secret changes and marks failures', async () => {
    const cache = createTotpCache();
    const rows = [row({ secret: 'AAAA' })];
    await refreshCodes(rows, 1_000, cache);
    expect(importTotpKey).toHaveBeenCalledTimes(1);

    rows[0].secret = 'BBBB';
    await refreshCodes(rows, 1_000, cache);
    expect(importTotpKey).toHaveBeenCalledTimes(2);

    vi.mocked(totpCodeForKey).mockRejectedValue(new Error('bad secret'));
    await refreshCodes(rows, 31_000, cache);
    expect(rows[0].code).toBe('------');
    expect(cache.has('r1')).toBe(false);
  });
});


describe('DEK 缓存编解码', () => {
  const dek = new Uint8Array(32).fill(7);
  const entry = { dek, userId: '1', keyEpoch: '2', exp: 1_000_000 };

  it('round-trips and validates expiry / userId / malformed input', () => {
    const raw = encodeDekCache(entry);
    const ok = decodeDekCache(raw, 999_999, '1');
    expect(ok?.keyEpoch).toBe('2');
    expect(Array.from(ok!.dek)).toEqual(Array.from(dek));
    expect(decodeDekCache(raw, 1_000_000, '1')).toBeUndefined(); // 过期（exp <= now）
    expect(decodeDekCache(raw, 999_999, '2')).toBeUndefined();   // 账号不匹配
    expect(decodeDekCache('not json', 0, '1')).toBeUndefined();
    expect(decodeDekCache(JSON.stringify({ v: 1, dek: 'AA', userId: '1', keyEpoch: '2', exp: 9 }), 0, '1')).toBeUndefined(); // 长度不足
    expect(decodeDekCache(null, 0, '1')).toBeUndefined();
    expect(DEK_CACHE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('toAuthenticatorGroup / toAuthenticatorTag', () => {
  it('maps group payload（身份 = recordId）', () => {
    expect(toAuthenticatorGroup('g1', { type: 'authenticatorGroup', name: 'G', sortOrder: 3 })).toEqual({ recordId: 'g1', name: 'G', sortOrder: 3 });
    expect(toAuthenticatorGroup('g1', { type: 'authenticatorEntry' })).toBeUndefined();
    expect(toAuthenticatorGroup('g1', { type: 'authenticatorGroup', sortOrder: 1 })).toBeUndefined();
  });

  it('maps tag payload', () => {
    expect(toAuthenticatorTag('t1', { type: 'authenticatorTag', name: 'prod' })).toEqual({ recordId: 't1', name: 'prod' });
    expect(toAuthenticatorTag('t1', { type: 'authenticatorTag' })).toBeUndefined();
  });
});

describe('toAuthenticatorRow 引用字段', () => {
  it('carries groupId / tags recordId 引用（过滤非字符串 tag）', () => {
    const r = toAuthenticatorRow('r', { type: 'authenticatorEntry', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, secret: 'A', groupId: 'g1', tags: ['t1', 5] });
    expect(r?.groupId).toBe('g1');
    expect(r?.tags).toEqual(['t1']);
  });
});

describe('collectAuthenticator / groupAuthenticator / tagNameMap', () => {
  it('collects entries + groups + tags，并正确分区、残留标签名', async () => {
    const payloads: Record<string, unknown> = {
      e: { type: 'authenticatorEntry', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, secret: 'A', groupId: 'g1', tags: ['t1'] },
      g: { type: 'authenticatorGroup', name: 'G', sortOrder: 1 },
      t: { type: 'authenticatorTag', name: 'prod' },
    };
    vi.mocked(openCipherRecord).mockImplementation(async (_d, r) => payloads[r.recordId]);
    const col = await collectAuthenticator(dek, ctx, async () => ({ records: [rec('e'), rec('g'), rec('t')] }));
    expect(col.rows).toHaveLength(1);
    expect(col.groups).toEqual([{ recordId: 'g', name: 'G', sortOrder: 1 }]);
    expect(col.tags).toEqual([{ recordId: 't', name: 'prod' }]);

    const sections = groupAuthenticator(col.rows, col.groups);
    expect(sections).toHaveLength(1);
    expect(sections[0].group?.name).toBe('G');
    expect(sections[0].rows[0].recordId).toBe('e');
    expect(tagNameMap(col.tags).get('t')).toBe('prod');
  });

  it('孤儿归入首个分组（按 sortOrder）；无分组时拍平', () => {
    const groups: AuthenticatorGroup[] = [
      { recordId: 'g1', name: 'A', sortOrder: 2 },
      { recordId: 'g2', name: 'B', sortOrder: 1 },
    ];
    const rows: AuthenticatorRow[] = [
      { recordId: 'r1', issuer: '', algorithm: 'SHA1', digits: 6, period: 30, secret: 'A', code: '', secondsLeft: 0, groupId: 'g2' },
      { recordId: 'r2', issuer: '', algorithm: 'SHA1', digits: 6, period: 30, secret: 'A', code: '', secondsLeft: 0 },
    ];
    const sections = groupAuthenticator(rows, groups);
    expect(sections.map((s) => s.group?.name)).toEqual(['B', 'A']);
    expect(sections[0].rows.map((r) => r.recordId)).toEqual(['r1', 'r2']);
    expect(groupAuthenticator(rows, [])).toEqual([{ rows }]);
  });
});
