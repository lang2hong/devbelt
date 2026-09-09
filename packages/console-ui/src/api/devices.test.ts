import { describe, expect, it } from 'vitest';
import { listDevices, revokeDevice } from './devices';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const device = { deviceId: '1', devicePlatform: 'web', deviceName: 'Web Console', clientVersion: null, status: 'active', lastUsedTime: null, createTime: '2026-01-01T00:00:00.000Z' };

describe('listDevices', () => {
  it('returns devices on ok', async () => {
    const body = { devices: [device] };
    const r = await listDevices('tok', async () => jsonRes(200, body));
    expect(r).toEqual({ kind: 'ok', devices: body.devices });
  });

  it('returns unauthorized without a token', async () => {
    const r = await listDevices(null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });
});

describe('revokeDevice', () => {
  it('sends the caller-provided idempotency key, CSRF and bearer', async () => {
    let captured: RequestInit | undefined;
    const r = await revokeDevice('5', 'fixed-key', 'csrf-tok', 'at', async (_url, init) => {
      captured = init;
      return jsonRes(200, { ok: true });
    });
    expect(r).toEqual({ kind: 'ok', currentSessionRevoked: false });
    const headers = captured?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('fixed-key');
    expect(headers['X-CSRF-Token']).toBe('csrf-tok');
    expect(headers.Authorization).toBe('Bearer at');
  });

  it('flags current session revoked', async () => {
    const r = await revokeDevice('5', 'k', 'csrf', 'at', async () => jsonRes(200, { ok: true, code: 'CURRENT_SESSION_REVOKED' }));
    expect(r).toEqual({ kind: 'ok', currentSessionRevoked: true });
  });

  it('maps 404 to not-found', async () => {
    const r = await revokeDevice('5', 'k', 'csrf', 'at', async () => jsonRes(404, { error: { code: 'NOT_FOUND' } }));
    expect(r).toEqual({ kind: 'not-found' });
  });
});