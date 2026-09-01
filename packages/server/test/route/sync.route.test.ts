import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'crypto';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import { jcs, requestDigestOf } from '../../src/service/syncCrypto.js';

function b64(n: number, fill: number): string {
  return Buffer.alloc(n, fill).toString('base64url');
}

function sha(raw: Buffer): Buffer {
  return createHash('sha256').update(raw).digest();
}

function makeKeys() {
  const a = generateKeyPairSync('ed25519');
  const b = generateKeyPairSync('ed25519');
  return {
    signPriv: a.privateKey,
    recoverPriv: b.privateKey,
    signPub: Buffer.from((a.publicKey.export({ format: 'jwk' }) as any).x, 'base64url'),
    recoverPub: Buffer.from((b.publicKey.export({ format: 'jwk' }) as any).x, 'base64url'),
  };
}

function withKeys(newState: Record<string, unknown>, keys: ReturnType<typeof makeKeys>): Record<string, unknown> {
  return { ...newState, signPub: keys.signPub.toString('base64url'), recoverSignPub: keys.recoverPub.toString('base64url') };
}

/** 客户端侧签名：body 不含 signature；digest = SHA-256(JCS(body))。 */
function signRecord(priv: KeyObject, userId: number, action: string, body: Record<string, unknown>) {
  const digest = requestDigestOf(body);
  const signingInput = {
    domain: 'dbclient/sync/v1', action, userId: String(userId),
    keyEpoch: body.keyEpoch, baseVersion: body.baseVersion, recordId: body.recordId,
    mutationId: body.mutationId, requestDigest: digest,
  };
  const signature = nodeSign(null, Buffer.from(jcs(signingInput), 'utf8'), priv);
  return { ...body, signature: signature.toString('base64url') };
}

function signState(priv: KeyObject, userId: number, action: string, body: Record<string, unknown>) {
  const digest = requestDigestOf(body);
  const signingInput = {
    domain: 'dbclient/sync/v1', action, userId: String(userId),
    keyEpoch: body.keyEpoch, expectedStateVersion: body.expectedStateVersion,
    mutationId: body.mutationId, requestDigest: digest,
  };
  const signature = nodeSign(null, Buffer.from(jcs(signingInput), 'utf8'), priv);
  return { ...body, signature: signature.toString('base64url') };
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
  await t.repos.userRepo.markEmailVerified({} as any, user.id, new Date());
  const token = await t.tokenFor(user.id);
  return { token, userId: user.id };
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

  it('reset-challenges requires auth and returns 202; reset-after-loss consumes the emailed token', async () => {
    const t = await buildTestApp();

    const anon = await t.app.inject({ method: 'POST', url: '/api/sync/reset-challenges' });
    expect(anon.statusCode).toBe(401);

    const { token } = await makeUser(t, 'reset@b.com');
    const chall = await t.app.inject({ method: 'POST', url: '/api/sync/reset-challenges', headers: t.auth(token) });
    expect(chall.statusCode).toBe(202);

    const sent = t.services.emailSender.sent.filter((e) => e.kind === 'reset_challenge');
    expect(sent).toHaveLength(1);
    const resetToken = sent[0].token!;

    const payload = {
      protocolVersion: 1, resetToken,
      confirmIrreversible: true, confirmDataLoss: true, confirmNoRecovery: true,
      newState: newStateBody(),
    };
    const res = await t.app.inject({ method: 'POST', url: '/api/sync/reset-after-loss', headers: t.auth(token), payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().keyEpoch).toBe('1');

    const reuse = await t.app.inject({ method: 'POST', url: '/api/sync/reset-after-loss', headers: t.auth(token), payload });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().code).toBe('VALIDATION_FAILED');
    await t.close();
  });

  it('reset-after-loss rejects unknown fields (strict schema)', async () => {
    const t = await buildTestApp();
    const { token } = await makeUser(t, 'reset-strict@b.com');
    const payload: any = {
      protocolVersion: 1, resetToken: b64(32, 9),
      confirmIrreversible: true, confirmDataLoss: true, confirmNoRecovery: true,
      newState: newStateBody(), bogus: true,
    };
    const res = await t.app.inject({ method: 'POST', url: '/api/sync/reset-after-loss', headers: t.auth(token), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    await t.close();
  });

  it('reset-after-loss returns an identical 400 body for unknown/expired/consumed/revoked/cross-user tokens', async () => {
    const t = await buildTestApp();
    const a = await makeUser(t, 'reset-eq@b.com');
    const bUser = await t.repos.userRepo.create('reset-other@b.com', 'hash', undefined);
    await t.repos.userRepo.markEmailVerified({} as any, bUser.id, new Date());

    const payload = (resetToken: string) => ({
      protocolVersion: 1, resetToken,
      confirmIrreversible: true, confirmDataLoss: true, confirmNoRecovery: true,
      newState: newStateBody(),
    });
    const expected = { message: 'reset token invalid', code: 'VALIDATION_FAILED' };
    const inject = (raw: Buffer, userId: number, expiresTime = new Date(Date.now() + 3600_000)) =>
      t.repos.syncResetTokenRepo.create({} as any, { userId, tokenHash: sha(raw), expiresTime });
    const post = (token: string, body: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url: '/api/sync/reset-after-loss', headers: t.auth(token), payload: body });

    // 未知
    let res = await post(a.token, payload(b64(32, 1)));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(expected);

    // 过期
    const expiredRaw = Buffer.alloc(32, 2);
    await inject(expiredRaw, a.userId, new Date(Date.now() - 1000));
    res = await post(a.token, payload(expiredRaw.toString('base64url')));
    expect(res.json()).toEqual(expected);

    // 已消费
    const consumedRaw = Buffer.alloc(32, 3);
    const cTok = await inject(consumedRaw, a.userId);
    await t.repos.syncResetTokenRepo.consume({} as any, cTok.id, new Date());
    res = await post(a.token, payload(consumedRaw.toString('base64url')));
    expect(res.json()).toEqual(expected);

    // 已撤销
    const revokedRaw = Buffer.alloc(32, 4);
    await inject(revokedRaw, a.userId);
    await t.repos.syncResetTokenRepo.revokePendingByUser({} as any, a.userId, new Date());
    res = await post(a.token, payload(revokedRaw.toString('base64url')));
    expect(res.json()).toEqual(expected);

    // 跨用户：token 属于 a，却以 b 的认证身份消费
    const crossRaw = Buffer.alloc(32, 5);
    await inject(crossRaw, a.userId);
    const bToken = await t.tokenFor(bUser.id);
    res = await post(bToken, payload(crossRaw.toString('base64url')));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(expected);

    await t.close();
  });

  it('put + delete record round-trip over HTTP (signed)', async () => {
    const t = await buildTestApp();
    const { token, userId } = await makeUser(t, 'sync-sign@b.com');
    const keys = makeKeys();
    const init = await t.app.inject({
      method: 'PUT', url: '/api/sync/init', headers: t.auth(token),
      payload: { newState: withKeys(newStateBody(), keys) },
    });
    expect(init.statusCode).toBe(201);

    const recordId = b64(8, 5);
    const create = signRecord(keys.signPriv, userId, 'record.put', {
      protocolVersion: 1, keyEpoch: '1', mutationId: b64(16, 9), recordId, baseVersion: '0',
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: b64(12, 8), ciphertext: b64(48, 90), tag: b64(16, 8),
    });
    const putRes = await t.app.inject({ method: 'PUT', url: `/api/sync/records/${recordId}`, headers: t.auth(token), payload: create });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().version).toBe('1');

    const del = signRecord(keys.signPriv, userId, 'record.delete', {
      protocolVersion: 1, keyEpoch: '1', mutationId: b64(16, 10), recordId, baseVersion: '1',
    });
    const delRes = await t.app.inject({ method: 'DELETE', url: `/api/sync/records/${recordId}`, headers: t.auth(token), payload: del });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().version).toBe('2');
    await t.close();
  });

  it('change-key over HTTP (signed) increments stateVersion; stale epoch → 409', async () => {
    const t = await buildTestApp();
    const { token, userId } = await makeUser(t, 'sync-ck@b.com');
    const keys = makeKeys();
    await t.app.inject({ method: 'PUT', url: '/api/sync/init', headers: t.auth(token), payload: { newState: withKeys(newStateBody(), keys) } });

    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: b64(16, 12), expectedStateVersion: '1',
      smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: b64(16, 2), outputBytes: 32 },
      envelopeSmp: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '2', nonce: b64(12, 40), ciphertext: b64(32, 41), tag: b64(16, 42) },
    };
    const res = await t.app.inject({ method: 'POST', url: '/api/sync/change-key', headers: t.auth(token), payload: signState(keys.signPriv, userId, 'state.change-key', body) });
    expect(res.statusCode).toBe(200);
    expect(res.json().stateVersion).toBe('2');

    const staleRes = await t.app.inject({ method: 'POST', url: '/api/sync/change-key', headers: t.auth(token), payload: signState(keys.signPriv, userId, 'state.change-key', { ...body, keyEpoch: '2' }) });
    expect(staleRes.statusCode).toBe(409);
    expect(staleRes.json().code).toBe('SYNC_EPOCH_STALE');
    await t.close();
  });

  it('destroy over HTTP (signed) rotates epoch', async () => {
    const t = await buildTestApp();
    const { token, userId } = await makeUser(t, 'sync-destroy@b.com');
    const keys = makeKeys();
    await t.app.inject({ method: 'PUT', url: '/api/sync/init', headers: t.auth(token), payload: { newState: withKeys(newStateBody(), keys) } });

    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: b64(16, 13), expectedStateVersion: '1',
      newState: withKeys(newStateBody(), makeKeys()),
    };
    const res = await t.app.inject({ method: 'POST', url: '/api/sync/destroy', headers: t.auth(token), payload: signState(keys.signPriv, userId, 'state.destroy', body) });
    expect(res.statusCode).toBe(200);
    expect(res.json().keyEpoch).toBe('2');
    await t.close();
  });

  it('recover over HTTP (signed with recovery key) rotates stateVersion', async () => {
    const t = await buildTestApp();
    const { token, userId } = await makeUser(t, 'sync-recover@b.com');
    const keys = makeKeys();
    await t.app.inject({ method: 'PUT', url: '/api/sync/init', headers: t.auth(token), payload: { newState: withKeys(newStateBody(), keys) } });

    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: b64(16, 14), expectedStateVersion: '1',
      smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: b64(16, 2), outputBytes: 32 },
      envelopeSmp: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '2', nonce: b64(12, 50), ciphertext: b64(32, 51), tag: b64(16, 52) },
      recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: b64(16, 3), outputBytes: 32 },
      envelopeRecovery: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '2', nonce: b64(12, 60), ciphertext: b64(32, 61), tag: b64(16, 62) },
      recoverSignPub: makeKeys().recoverPub.toString('base64url'),
    };
    const res = await t.app.inject({ method: 'POST', url: '/api/sync/recover', headers: t.auth(token), payload: signState(keys.recoverPriv, userId, 'state.recover', body) });
    expect(res.statusCode).toBe(200);
    expect(res.json().stateVersion).toBe('2');
    await t.close();
  });

  it('unknown protocol / cipher → 400 SYNC_PROTOCOL_UNSUPPORTED (not VALIDATION_FAILED)', async () => {
    const t = await buildTestApp();
    const { token } = await makeUser(t, 'sync-proto@b.com');

    const bad = newStateBody() as any;
    bad.protocolVersion = 2;
    const initBad = await t.app.inject({ method: 'PUT', url: '/api/sync/init', headers: t.auth(token), payload: { newState: bad } });
    expect(initBad.statusCode).toBe(400);
    expect(initBad.json().code).toBe('SYNC_PROTOCOL_UNSUPPORTED');

    const keys = makeKeys();
    await t.app.inject({ method: 'PUT', url: '/api/sync/init', headers: t.auth(token), payload: { newState: withKeys(newStateBody(), keys) } });
    const rec = {
      protocolVersion: 1, keyEpoch: '1', mutationId: b64(16, 9), signature: b64(64, 1), recordId: b64(8, 6), baseVersion: '0',
      cipherSuite: 'CHACHA20', formatVersion: 1, nonce: b64(12, 8), ciphertext: b64(48, 90), tag: b64(16, 8),
    };
    const recRes = await t.app.inject({ method: 'PUT', url: `/api/sync/records/${rec.recordId}`, headers: t.auth(token), payload: rec });
    expect(recRes.statusCode).toBe(400);
    expect(recRes.json().code).toBe('SYNC_PROTOCOL_UNSUPPORTED');
    await t.close();
  });
});
