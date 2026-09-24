import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@devbelt/auth-client', () => ({ openCipherRecord: vi.fn() }));

import { openCipherRecord } from '@devbelt/auth-client';
import { collectAuthenticatorRows, toAuthenticatorRow } from './authenticatorView';

const rec = (recordId: string) => ({ recordId, version: '1', changeSequence: recordId, deleteTime: null });
const dek = new Uint8Array(32).fill(1);
const ctx = { userId: '7', keyEpoch: '1' };

describe('toAuthenticatorRow', () => {
  it('maps a valid authenticatorEntry payload', () => {
    const row = toAuthenticatorRow('r1', {
      type: 'authenticatorEntry', issuer: 'Acme', account: 'a@b', algorithm: 'SHA256', digits: 8, period: 60, secret: 'ABCD',
    });
    expect(row).toMatchObject({
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
    const row = toAuthenticatorRow('r', { type: 'authenticatorEntry', algorithm: 'SHA1', digits: 6, period: 30, secret: 'A' });
    expect(row).toMatchObject({ issuer: '', account: undefined });
  });
});

describe('collectAuthenticatorRows', () => {
  beforeEach(() => { vi.mocked(openCipherRecord).mockReset(); });

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
