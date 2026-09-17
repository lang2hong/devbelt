import { describe, expect, it, beforeEach } from 'vitest';
import { setAccessToken } from '@devkit/auth-client';
import { listPlans } from './plans';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CATALOG = {
  personal: [
    { code: 'free', name: 'Free', billing: { unit: 'month' as const, priceCents: 0 }, features: [] },
    { code: 'pro', name: 'Pro', billing: { unit: 'month' as const, priceCents: 9900 }, features: [] },
  ],
  organization: [],
};

beforeEach(() => setAccessToken(null));

describe('listPlans', () => {
  it('returns the catalog', async () => {
    const r = await listPlans('tok', async () => jsonResponse(200, CATALOG));
    expect(r).toEqual({ kind: 'ok', value: CATALOG });
  });

  it('returns unauthorized without a token', async () => {
    const r = await listPlans(null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });

  it('returns failure on a server error', async () => {
    const r = await listPlans('tok', async () => jsonResponse(500, { error: { code: 'INTERNAL' } }));
    expect(r).toEqual({ kind: 'failure' });
  });
});