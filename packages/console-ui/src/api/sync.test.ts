import { describe, expect, it } from 'vitest';
import { syncOverview } from './sync';

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