import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'crypto';
import { FakeSyncStateRepo, FakeSyncRecordRepo, FakeSyncMutationRepo } from '../helpers/fakeRepos.js';
import { SyncStateService } from '../../src/modules/db/service/syncStateService.js';
import { jcs, requestDigestOf } from '../../src/modules/db/service/syncCrypto.js';
import {
  SyncNotInitializedError,
  SyncStateExistsError,
  SyncEpochStaleError,
  SyncSignatureInvalidError,
  SyncVersionConflictError,
  ConflictError,
  ValidationError,
} from '../../src/domain/errors.js';
import type { SmpKdf, RecoveryKdf, SyncEnvelope } from '../../src/domain/entities.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const runner = ((fn: any) => fn({} as Queryable));

function buf(n: number, fill = 1): Buffer { return Buffer.alloc(n, fill); }

// salt 的填充字节可变：envelope 重写时服务端要求 salt/nonce 必须换新
// （防 AES-GCM 密钥流复用），故夹具需要能产出不同的 salt。
function smpKdf(saltFill = 2): SmpKdf {
  return { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: buf(16, saltFill), outputBytes: 32 };
}
function recoveryKdf(saltFill = 3): RecoveryKdf {
  return { alg: 'hkdf-sha256', version: 1, salt: buf(16, saltFill), outputBytes: 32 };
}
function env(version: string, fill = 4): SyncEnvelope {
  return { version, nonce: buf(12, fill), ct: buf(32, fill + 1), tag: buf(16, fill + 2) };
}
function accountKey(fill = 99): Buffer { return buf(32, fill); }

function b64kdf(k: SmpKdf | RecoveryKdf): Record<string, unknown> {
  return { ...k, salt: k.salt.toString('base64url') };
}
function b64env(e: SyncEnvelope): Record<string, unknown> {
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: e.version,
    nonce: e.nonce.toString('base64url'), ciphertext: e.ct.toString('base64url'), tag: e.tag.toString('base64url'),
  };
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

/** 客户端侧签名：body 不含 signature；digest = SHA256(JCS(body))。 */
function signBody(priv: KeyObject, userId: number, action: string, body: Record<string, unknown>) {
  const digest = requestDigestOf(body);
  const signingInput = {
    domain: 'dbclient/sync/v1', action, userId: String(userId),
    keyEpoch: body.keyEpoch, expectedStateVersion: body.expectedStateVersion,
    mutationId: body.mutationId, requestDigest: digest,
  };
  const signature = nodeSign(null, Buffer.from(jcs(signingInput), 'utf8'), priv);
  return { digest, signatureBuf: signature };
}

function makeStack() {
  const stateRepo = new FakeSyncStateRepo();
  const recordRepo = new FakeSyncRecordRepo();
  const mutationRepo = new FakeSyncMutationRepo();
  const svc = new SyncStateService(stateRepo, recordRepo, mutationRepo, runner);
  return { stateRepo, recordRepo, mutationRepo, svc };
}

const USER = 42;
const MID = Buffer.alloc(16, 9).toString('base64url');

describe('SyncStateService', () => {
  it('getState requires init; init is first-writer-wins', async () => {
    const { svc } = makeStack();
    const keys = makeKeys();
    await expect(svc.getState(USER)).rejects.toBeInstanceOf(SyncNotInitializedError);

    const ns = {
      protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(),
      envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    };
    await svc.init(USER, ns);
    await expect(svc.init(USER, ns)).rejects.toBeInstanceOf(SyncStateExistsError);

    const state = await svc.getState(USER);
    expect(state.keyEpoch).toBe('1');
    expect(state.stateVersion).toBe('1');
    expect(state.envelopeSmp.envelopeVersion).toBe('1');
    expect(state.envelopeSmp.ciphertext).not.toBe('');
    expect(state.envelopeSmp.protocolVersion).toBe(1);
  });

  it('change-key succeeds and increments stateVersion; replay is idempotent; wrong digest conflicts', async () => {
    const { svc } = makeStack();
    const keys = makeKeys();
    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(), envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });

    const mutationId = MID;
    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId, expectedStateVersion: '1',
      smpKdf: b64kdf(smpKdf(22)), envelopeSmp: b64env(env('2', 40)),
    };
    const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.change-key', body);

    const input = {
      keyEpoch: '1', mutationId, signature: signatureBuf, expectedStateVersion: '1', requestDigest: digest,
      smpKdf: smpKdf(22), envelopeSmp: env('2', 40),
    };

    const res = await svc.changeKey(USER, input);
    expect(res.stateVersion).toBe('2');

    // 幂等重放：同 mutationId 同 digest → 返回原结果，不重复递增。
    const replay = await svc.changeKey(USER, input);
    expect(replay.stateVersion).toBe('2');

    // 同 id 异 digest → 409 CONFLICT。
    const otherBody = { ...body, envelopeSmp: b64env(env('2', 41)) };
    const other = signBody(keys.signPriv, USER, 'state.change-key', otherBody);
    await expect(svc.changeKey(USER, { ...input, requestDigest: other.digest, signature: other.signatureBuf }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it('change-key rejects stale epoch, bad signature and version conflicts', async () => {
    const { svc } = makeStack();
    const keys = makeKeys();
    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(), envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });

    const base = { protocolVersion: 1, mutationId: MID, smpKdf: b64kdf(smpKdf(22)), envelopeSmp: b64env(env('2', 40)) };

    // stale epoch
    const staleBody = { ...base, keyEpoch: '2', expectedStateVersion: '1' };
    const stale = signBody(keys.signPriv, USER, 'state.change-key', staleBody);
    await expect(svc.changeKey(USER, { keyEpoch: '2', mutationId: MID, signature: stale.signatureBuf, expectedStateVersion: '1', requestDigest: stale.digest, smpKdf: smpKdf(22), envelopeSmp: env('2', 40) }))
      .rejects.toBeInstanceOf(SyncEpochStaleError);

    // bad signature（用别人的私钥签名）
    const otherKeys = makeKeys();
    const badBody = { ...base, keyEpoch: '1', expectedStateVersion: '1' };
    const bad = signBody(otherKeys.signPriv, USER, 'state.change-key', badBody);
    await expect(svc.changeKey(USER, { keyEpoch: '1', mutationId: MID, signature: bad.signatureBuf, expectedStateVersion: '1', requestDigest: bad.digest, smpKdf: smpKdf(22), envelopeSmp: env('2', 40) }))
      .rejects.toBeInstanceOf(SyncSignatureInvalidError);

    // version conflict（expectedStateVersion 错）
    const verBody = { ...base, keyEpoch: '1', expectedStateVersion: '99' };
    const ver = signBody(keys.signPriv, USER, 'state.change-key', verBody);
    await expect(svc.changeKey(USER, { keyEpoch: '1', mutationId: MID, signature: ver.signatureBuf, expectedStateVersion: '99', requestDigest: ver.digest, smpKdf: smpKdf(22), envelopeSmp: env('2', 40) }))
      .rejects.toBeInstanceOf(SyncVersionConflictError);
  });

  it('recover rotates recovery envelope and recoverSignPub using recovery key', async () => {
    const { svc } = makeStack();
    const keys = makeKeys();
    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(), envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });

    const newRecoverPub = makeKeys().recoverPub;
    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: MID, expectedStateVersion: '1',
      smpKdf: b64kdf(smpKdf(22)),
      envelopeSmp: b64env(env('2', 50)),
      recoveryKdf: b64kdf(recoveryKdf(33)),
      envelopeRecovery: b64env(env('2', 60)),
      recoverSignPub: newRecoverPub.toString('base64url'),
    };
    const { digest, signatureBuf } = signBody(keys.recoverPriv, USER, 'state.recover', body);
    const res = await svc.recover(USER, {
      keyEpoch: '1', mutationId: MID, signature: signatureBuf, expectedStateVersion: '1', requestDigest: digest,
      smpKdf: smpKdf(22), envelopeSmp: env('2', 50),
      recoveryKdf: recoveryKdf(33), envelopeRecovery: env('2', 60), recoverSignPub: newRecoverPub,
    });
    expect(res.stateVersion).toBe('2');
    const state = await svc.getState(USER);
    expect(state.envelopeRecovery.envelopeVersion).toBe('2');
  });

  it('destroy tombstones records (version+1) and advances global changeSequence', async () => {
    const { svc, recordRepo } = makeStack();
    const keys = makeKeys();
    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(), envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });

    const recordId = buf(16, 70);
    await recordRepo.create({} as Queryable, {
      userId: USER, keyEpoch: '1', recordId,
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: buf(12, 71), ciphertext: buf(50, 72), tag: buf(16, 73),
      version: '1', changeSequence: '0',
    });

    const newKeys = makeKeys();
    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: MID, expectedStateVersion: '1',
      newState: {
        protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
        smpKdf: b64kdf(smpKdf(22)), recoveryKdf: b64kdf(recoveryKdf(33)),
        envelopeSmp: b64env(env('1', 70)), envelopeRecovery: b64env(env('1', 80)), envelopeAccount: b64env(env('1', 91)), accountRecoveryKey: accountKey(100).toString('base64url'),
        signPub: newKeys.signPub.toString('base64url'), recoverSignPub: newKeys.recoverPub.toString('base64url'),
      },
    };
    const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.destroy', body);
    const destroyInput = {
      keyEpoch: '1', mutationId: MID, signature: signatureBuf, expectedStateVersion: '1', requestDigest: digest,
      newState: {
        protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const,
        smpKdf: smpKdf(22), recoveryKdf: recoveryKdf(33), envelopeSmp: env('1', 70), envelopeRecovery: env('1', 80), envelopeAccount: env('1', 91), accountRecoveryKey: accountKey(100),
        signPub: newKeys.signPub, recoverSignPub: newKeys.recoverPub,
      },
    };
    const res = await svc.destroy(USER, destroyInput);
    expect(res.keyEpoch).toBe('2');

    expect((await recordRepo.countActive({} as Queryable, USER, '1')).count).toBe(0);
    const tomb = await recordRepo.findForUpdate({} as Queryable, USER, '1', recordId);
    expect(tomb?.deleteTime).not.toBeNull();
    expect(tomb?.version).toBe('2');

    const state = await svc.getState(USER);
    expect(state.keyEpoch).toBe('2');
    expect(state.stateVersion).toBe('1');
    expect(state.changeSequence).toBe('1');
  });

  it('destroy replay is idempotent and returns full snapshot', async () => {
    const { svc } = makeStack();
    const keys = makeKeys();
    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(), envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });

    const newKeys = makeKeys();
    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: MID, expectedStateVersion: '1',
      newState: {
        protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
        smpKdf: b64kdf(smpKdf(22)), recoveryKdf: b64kdf(recoveryKdf(33)),
        envelopeSmp: b64env(env('1', 70)), envelopeRecovery: b64env(env('1', 80)), envelopeAccount: b64env(env('1', 91)), accountRecoveryKey: accountKey(100).toString('base64url'),
        signPub: newKeys.signPub.toString('base64url'), recoverSignPub: newKeys.recoverPub.toString('base64url'),
      },
    };
    const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.destroy', body);
    const destroyInput = {
      keyEpoch: '1', mutationId: MID, signature: signatureBuf, expectedStateVersion: '1', requestDigest: digest,
      newState: {
        protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const,
        smpKdf: smpKdf(22), recoveryKdf: recoveryKdf(33), envelopeSmp: env('1', 70), envelopeRecovery: env('1', 80), envelopeAccount: env('1', 91), accountRecoveryKey: accountKey(100),
        signPub: newKeys.signPub, recoverSignPub: newKeys.recoverPub,
      },
    };
    const first = await svc.destroy(USER, destroyInput);
    // 重放同一请求（旧 epoch）必须幂等返回完整快照，而非 409 epoch stale
    const replay = await svc.destroy(USER, destroyInput);
    expect(replay).toEqual({ keyEpoch: '2', stateVersion: '1', changeSequence: first.changeSequence });
    expect(first.changeSequence).toBe('0');
  });

  it('expired receipt is ignored (different-digest stale receipt does not conflict)', async () => {
    const { svc, mutationRepo } = makeStack();
    const keys = makeKeys();
    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(), envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });

    // 预置一个已过期、且 digest 不同的 receipt（同 mutationId）。
    await mutationRepo.record({} as Queryable, {
      userId: USER, keyEpoch: '1', mutationId: Buffer.from(MID, 'base64url'),
      requestDigest: buf(32, 99), action: 'state.change-key', resultVersion: '9', resultChangeSequence: null, resultRecoveryCodeSetTime: null,
      status: 'applied', expiresTime: new Date(0),
    });

    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: MID, expectedStateVersion: '1',
      smpKdf: b64kdf(smpKdf(22)), envelopeSmp: b64env(env('2', 40)),
    };
    const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.change-key', body);
    // 正常校验通过（不再命中过期 receipt；也不因异 digest 而 409）。
    const res = await svc.changeKey(USER, {
      keyEpoch: '1', mutationId: MID, signature: signatureBuf, expectedStateVersion: '1', requestDigest: digest,
      smpKdf: smpKdf(22), envelopeSmp: env('2', 40),
    });
    expect(res.stateVersion).toBe('2');
  });
it('recover-via-account returns account recovery material after init; not-initialized rejects', async () => {
    const { svc } = makeStack();
    const keys = makeKeys();
    await expect(svc.recoverViaAccount(USER)).rejects.toBeInstanceOf(SyncNotInitializedError);

    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(),
      envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });
    const r = await svc.recoverViaAccount(USER);
    expect(r.accountRecoveryKey.toString('hex')).toBe(accountKey().toString('hex'));
    expect(r.envelopeAccount.version).toBe('1');
  });

  it('init rejects a newState with invalid account-recovery material (bad key length / nonzero envelope version)', async () => {
    const { svc } = makeStack();
    const keys = makeKeys();
    await expect(svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(),
      envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: buf(31, 99),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    })).rejects.toBeInstanceOf(ValidationError);

    await expect(svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(),
      envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('2', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('recover-by-account re-rotates all three envelopes using the sync sign key (signPub)', async () => {
    const { svc } = makeStack();
    const keys = makeKeys();
    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(),
      envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });

    const newKeys = makeKeys();
    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: MID, expectedStateVersion: '1',
      smpKdf: b64kdf(smpKdf(22)),
      envelopeSmp: b64env(env('2', 40)),
      recoveryKdf: b64kdf(recoveryKdf(33)),
      envelopeRecovery: b64env(env('2', 50)),
      envelopeAccount: b64env(env('2', 91)),
      accountRecoveryKey: buf(32, 100).toString('base64url'),
      recoverSignPub: newKeys.recoverPub.toString('base64url'),
    };
    const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.recover-by-account', body);

    // 用 recoverSign 私钥签名 → 签名无效（recover-by-account 需要 signPriv，即 DEK 派生的 syncSign）。
    const { signatureBuf: badSig } = signBody(keys.recoverPriv, USER, 'state.recover-by-account', body);
    await expect(svc.recoverByAccount(USER, {
      keyEpoch: '1', mutationId: MID, signature: badSig, expectedStateVersion: '1', requestDigest: digest,
      smpKdf: smpKdf(22), envelopeSmp: env('2', 40),
      recoveryKdf: recoveryKdf(33), envelopeRecovery: env('2', 50),
      envelopeAccount: env('2', 91), accountRecoveryKey: buf(32, 100),
      recoverSignPub: newKeys.recoverPub,
    })).rejects.toBeInstanceOf(SyncSignatureInvalidError);

    const res = await svc.recoverByAccount(USER, {
      keyEpoch: '1', mutationId: MID, signature: signatureBuf, expectedStateVersion: '1', requestDigest: digest,
      smpKdf: smpKdf(22), envelopeSmp: env('2', 40),
      recoveryKdf: recoveryKdf(33), envelopeRecovery: env('2', 50),
      envelopeAccount: env('2', 91), accountRecoveryKey: buf(32, 100),
      recoverSignPub: newKeys.recoverPub,
    });
    expect(res.stateVersion).toBe('2');
    const state = await svc.getState(USER);
    expect(state.envelopeRecovery.envelopeVersion).toBe('2');
    expect(state.envelopeRecovery.ciphertext).toBeTruthy();
  });

  it('account-recover replay skips the keys rate limit (receipt-first)', async () => {
    const keys = makeKeys();
    const stateRepo = new FakeSyncStateRepo();
    const recordRepo = new FakeSyncRecordRepo();
    const mutationRepo = new FakeSyncMutationRepo();
    let limitCalls = 0;
    const svc = new SyncStateService(stateRepo, recordRepo, mutationRepo, runner, async () => { limitCalls += 1; });

    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(),
      envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });

    const newKeys = makeKeys();
    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: MID, expectedStateVersion: '1',
      smpKdf: b64kdf(smpKdf(22)), envelopeSmp: b64env(env('2', 40)),
      recoveryKdf: b64kdf(recoveryKdf(33)), envelopeRecovery: b64env(env('2', 50)),
      envelopeAccount: b64env(env('2', 91)), accountRecoveryKey: buf(32, 100).toString('base64url'),
      recoverSignPub: newKeys.recoverPub.toString('base64url'),
    };
    const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.recover-by-account', body);
    const input = {
      keyEpoch: '1', mutationId: MID, signature: signatureBuf, expectedStateVersion: '1', requestDigest: digest,
      smpKdf: smpKdf(22), envelopeSmp: env('2', 40),
      recoveryKdf: recoveryKdf(33), envelopeRecovery: env('2', 50),
      envelopeAccount: env('2', 91), accountRecoveryKey: buf(32, 100),
      recoverSignPub: newKeys.recoverPub,
    };

    const first = await svc.recoverByAccount(USER, input);
    expect(first.stateVersion).toBe('2');
    expect(limitCalls).toBe(1);

    const replay = await svc.recoverByAccount(USER, input); // 回执命中，不再计数
    expect(replay.stateVersion).toBe('2');
    expect(limitCalls).toBe(1);
  });

  it('recover-by-account replay returns the original recovery timestamp (not the later state value)', async () => {
    vi.useFakeTimers();
    try {
      const keys = makeKeys();
      const stateRepo = new FakeSyncStateRepo();
      const recordRepo = new FakeSyncRecordRepo();
      const mutationRepo = new FakeSyncMutationRepo();
      const svc = new SyncStateService(stateRepo, recordRepo, mutationRepo, runner);

      await svc.init(USER, {
        protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
        smpKdf: smpKdf(), recoveryKdf: recoveryKdf(),
        envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
        signPub: keys.signPub, recoverSignPub: keys.recoverPub,
      });

      const t1 = new Date('2026-01-01T00:00:00.000Z');
      const t2 = new Date('2026-01-01T01:00:00.000Z');

      const mk = (mutationId: string, version: string, fill: number) => {
        const newKeys = makeKeys();
        const v = String(Number(version) + 1);
        const body = {
          protocolVersion: 1, keyEpoch: '1', mutationId, expectedStateVersion: version,
          smpKdf: b64kdf(smpKdf(fill)), envelopeSmp: b64env(env(v, fill)),
          recoveryKdf: b64kdf(recoveryKdf(fill + 1)), envelopeRecovery: b64env(env(v, fill + 1)),
          envelopeAccount: b64env(env(v, fill + 2)), accountRecoveryKey: buf(32, fill + 80).toString('base64url'),
          recoverSignPub: newKeys.recoverPub.toString('base64url'),
        };
        const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.recover-by-account', body);
        return {
          keyEpoch: '1', mutationId, signature: signatureBuf, expectedStateVersion: version, requestDigest: digest,
          smpKdf: smpKdf(fill), envelopeSmp: env(v, fill),
          recoveryKdf: recoveryKdf(fill + 1), envelopeRecovery: env(v, fill + 1),
          envelopeAccount: env(v, fill + 2), accountRecoveryKey: buf(32, fill + 80),
          recoverSignPub: newKeys.recoverPub,
        };
      };

      const m1 = Buffer.alloc(16, 9).toString('base64url');
      const m2 = Buffer.alloc(16, 10).toString('base64url');

      vi.setSystemTime(t1);
      const input1 = mk(m1, '1', 22);
      await svc.recoverByAccount(USER, input1); // stateVersion -> 2

      vi.setSystemTime(t2);
      const input2 = mk(m2, '2', 30);
      await svc.recoverByAccount(USER, input2); // stateVersion -> 3

      const replay = await svc.recoverByAccount(USER, input1); // 回执命中
      expect(replay.stateVersion).toBe('2');
      expect(replay.recoveryCodeSetTime).toBe(t1.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('change-key without account material leaves an already-enabled account envelope untouched', async () => {
    const { svc } = makeStack();
    const keys = makeKeys();
    await svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(),
      envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });

    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: MID, expectedStateVersion: '1',
      smpKdf: b64kdf(smpKdf(22)), envelopeSmp: b64env(env('2', 40)),
    };
    const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.change-key', body);
    await svc.changeKey(USER, {
      keyEpoch: '1', mutationId: MID, signature: signatureBuf, expectedStateVersion: '1', requestDigest: digest,
      smpKdf: smpKdf(22), envelopeSmp: env('2', 40),
    });

    const r = await svc.recoverViaAccount(USER);
    expect(r.envelopeAccount.version).toBe('1'); // 未轮换
  });

  });

describe('AES-GCM keystream reuse prevention (envelope freshness)', () => {
  /** 建好一个已 init 的栈，返回 change-key 所需的签名构造器。 */
  async function initialized() {
    const stack = makeStack();
    const keys = makeKeys();
    await stack.svc.init(USER, {
      protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      smpKdf: smpKdf(), recoveryKdf: recoveryKdf(), envelopeSmp: env('1'), envelopeRecovery: env('1'), envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
      signPub: keys.signPub, recoverSignPub: keys.recoverPub,
    });
    return { ...stack, keys };
  }

  function changeKeyInput(keys: ReturnType<typeof makeKeys>, kdf: SmpKdf, envelope: SyncEnvelope) {
    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: MID, expectedStateVersion: '1',
      smpKdf: b64kdf(kdf), envelopeSmp: b64env(envelope),
    };
    const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.change-key', body);
    return {
      keyEpoch: '1', mutationId: MID, signature: signatureBuf, expectedStateVersion: '1',
      requestDigest: digest, smpKdf: kdf, envelopeSmp: envelope,
    };
  }

  it('rejects change-key that reuses the stored KDF salt', async () => {
    const { svc, keys } = await initialized();
    // salt 沿用已存值 → 同口令派生出同一把 KEK。
    await expect(svc.changeKey(USER, changeKeyInput(keys, smpKdf(2), env('2', 40))))
      .rejects.toThrow(/salt must be freshly generated/);
  });

  it('rejects change-key that reuses the stored GCM nonce', async () => {
    const { svc, keys } = await initialized();
    // salt 换新但 nonce 沿用 env('1') 的 fill=4 → 同一段密钥流。
    await expect(svc.changeKey(USER, changeKeyInput(keys, smpKdf(22), env('2', 4))))
      .rejects.toThrow(/nonce must be freshly generated/);
  });

  it('accepts change-key when both salt and nonce are fresh', async () => {
    const { svc, keys } = await initialized();
    const res = await svc.changeKey(USER, changeKeyInput(keys, smpKdf(22), env('2', 40)));
    expect(res.stateVersion).toBe('2');
  });

  it('rejects destroy that reuses the account recovery key / account nonce', async () => {
    const { svc, keys } = await initialized();
    const newKeys = makeKeys();
    const body = {
      protocolVersion: 1, keyEpoch: '1', mutationId: MID, expectedStateVersion: '1',
      newState: {
        protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
        smpKdf: b64kdf(smpKdf(22)), recoveryKdf: b64kdf(recoveryKdf(33)),
        envelopeSmp: b64env(env('1', 70)), envelopeRecovery: b64env(env('1', 80)),
        // 复用 init 时的账号信封 nonce 与账号恢复钥匙 → AES-GCM 密钥流复用。
        envelopeAccount: b64env(env('1', 90)), accountRecoveryKey: accountKey().toString('base64url'),
        signPub: newKeys.signPub.toString('base64url'), recoverSignPub: newKeys.recoverPub.toString('base64url'),
      },
    };
    const { digest, signatureBuf } = signBody(keys.signPriv, USER, 'state.destroy', body);
    await expect(svc.destroy(USER, {
      keyEpoch: '1', mutationId: MID, signature: signatureBuf, expectedStateVersion: '1', requestDigest: digest,
      newState: {
        protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const,
        smpKdf: smpKdf(22), recoveryKdf: recoveryKdf(33), envelopeSmp: env('1', 70), envelopeRecovery: env('1', 80),
        envelopeAccount: env('1', 90), accountRecoveryKey: accountKey(),
        signPub: newKeys.signPub, recoverSignPub: newKeys.recoverPub,
      },
    })).rejects.toThrow(/account/);
  });
});
