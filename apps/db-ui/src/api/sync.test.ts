import { describe, expect, it } from 'vitest';
import { getE2eeParams, getSyncRecords, syncOverview } from './sync';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('syncOverview', () => {
  it('returns overview payload', async () => {
    const body = { initialized: true, lastActivityTime: null, activeRecordCount: 0, ciphertextBytes: 0, recordLimit: null, storageLimit: null };
    const r = await syncOverview('tok', async () => jsonRes(200, body));
    expect(r).toEqual({ kind: 'ok', value: body });
  });

  it('returns unauthorized without a token', async () => {
    const r = await syncOverview(null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });
});

describe('getE2eeParams', () => {
  it('fetches e2ee params with a bearer token', async () => {
    const body = { initialized: true, keyEpoch: '1' };
    let seenUrl = '';
    let seenAuth: string | null = null;
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      seenUrl = input;
      seenAuth = new Headers(init?.headers).get('Authorization');
      return jsonRes(200, body);
    };
    const r = await getE2eeParams('tok', fetchImpl);
    expect(r).toEqual({ kind: 'ok', value: body });
    expect(seenUrl).toBe('/api/db/console/sync/e2ee-params');
    expect(seenAuth).toBe('Bearer tok');
  });

  it('returns unauthorized without a token', async () => {
    const r = await getE2eeParams(null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });

  it('maps 401 to unauthorized and 500 to failure', async () => {
    expect(await getE2eeParams('tok', async () => jsonRes(401, {}))).toEqual({ kind: 'unauthorized' });
    expect(await getE2eeParams('tok', async () => jsonRes(500, {}))).toEqual({ kind: 'failure' });
  });

  it('maps a thrown fetch to failure', async () => {
    const r = await getE2eeParams('tok', (() => { throw new Error('boom'); }) as never);
    expect(r).toEqual({ kind: 'failure' });
  });
});

describe('getSyncRecords', () => {
  it('encodes after/limit in the query string and sends the token', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      seenUrl = input;
      seenAuth = new Headers(init?.headers).get('Authorization');
      return jsonRes(200, { initialized: true, snapshotSequence: '0', records: [] });
    };
    const r = await getSyncRecords('5', 100, 'tok', fetchImpl);
    expect(r).toEqual({ kind: 'ok', value: { initialized: true, snapshotSequence: '0', records: [] } });
    expect(seenUrl).toBe('/api/db/console/sync/records?after=5&limit=100');
    expect(seenAuth).toBe('Bearer tok');
  });

  it('defaults to after=0 with the default page size', async () => {
    let seenUrl = '';
    const fetchImpl = async (input: string): Promise<Response> => { seenUrl = input; return jsonRes(200, { initialized: true, snapshotSequence: '0', records: [] }); };
    await getSyncRecords('0', 256, 'tok', fetchImpl);
    expect(seenUrl).toBe('/api/db/console/sync/records?after=0&limit=256');
  });

  it('returns unauthorized without a token', async () => {
    const r = await getSyncRecords('0', 256, null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });
});
