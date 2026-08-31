import { describe, it, expect } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

function b64(n: number, fill: number): string {
  return Buffer.alloc(n, fill).toString('base64url');
}

function newStateBody() {
  const envelope = (version: string, f: number) => ({
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: version,
    nonce: b64(12, f), ciphertext: b64(32, f + 1), tag: b64(16, f + 2),
  });
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: b64(16, 2), outputBytes: 32 },
    recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: b64(16, 3), outputBytes: 32 },
    envelopeSmp: envelope('1', 4),
    envelopeRecovery: envelope('1', 7),
    signPub: b64(32, 10),
    recoverSignPub: b64(32, 11),
  };
}

async function makeUser(t: TestApp, email: string) {
  const user = await t.repos.userRepo.create(email, 'hash', undefined);
  const token = await t.tokenFor(user.id);
  return { token };
}

describe('sync routes smoke', () => {
  it('requires auth and runs an init round-trip', async () => {
    const t = await buildTestApp();

    const anon = await t.app.inject({ method: 'GET', url: '/api/sync/state' });
    expect(anon.statusCode).toBe(401);

    const { token } = await makeUser(t, 'sync@b.com');
    const init = await t.app.inject({
      method: 'PUT', url: '/api/sync/init', headers: t.auth(token),
      payload: { newState: newStateBody() },
    });
    expect(init.statusCode).toBe(201);

    const again = await t.app.inject({
      method: 'PUT', url: '/api/sync/init', headers: t.auth(token),
      payload: { newState: newStateBody() },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('SYNC_STATE_EXISTS');

    const state = await t.app.inject({ method: 'GET', url: '/api/sync/state', headers: t.auth(token) });
    expect(state.statusCode).toBe(200);
    expect(state.json().keyEpoch).toBe('1');
    expect(state.json().stateVersion).toBe('1');

    const records = await t.app.inject({ method: 'GET', url: '/api/sync/records', headers: t.auth(token) });
    expect(records.statusCode).toBe(200);
    expect(records.json().records).toEqual([]);
    await t.close();
  });

  it('records endpoint requires authentication', async () => {
    const t = await buildTestApp();
    const anon = await t.app.inject({ method: 'GET', url: '/api/sync/records' });
    expect(anon.statusCode).toBe(401);
    await t.close();
  });

  it('rejects unknown fields on init (strict schema)', async () => {
    const t = await buildTestApp();
    const { token } = await makeUser(t, 'sync-strict@b.com');
    const nstate = newStateBody() as any;
    nstate.bogus = true;
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync/init', headers: t.auth(token),
      payload: { newState: nstate },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    await t.close();
  });
});