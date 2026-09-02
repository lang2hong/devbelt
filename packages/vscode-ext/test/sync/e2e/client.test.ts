import { describe, expect, it, vi } from 'vitest';
import { PersonalSyncClient } from '../../../src/sync/e2e/client';

function makeHttp(status = 200) {
  return { requestRaw: vi.fn(async () => ({ status, body: {} })) } as any;
}

function seed(): Uint8Array {
  return new Uint8Array(32).fill(1);
}

const smpKdf = { alg: 'argon2id' as const, version: 1 as const, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'A'.repeat(22), outputBytes: 32 as const };
const recoveryKdf = { alg: 'hkdf-sha256' as const, version: 1 as const, salt: 'A'.repeat(22), outputBytes: 32 as const };
const envelope = { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, envelopeVersion: '1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(43), tag: 'A'.repeat(22) };
const newState = { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, smpKdf, recoveryKdf, envelopeSmp: envelope, envelopeRecovery: envelope, signPub: 'A'.repeat(43), recoverSignPub: 'A'.repeat(43) };

describe('PersonalSyncClient 无签名方法', () => {
  it('getState → GET /api/sync/state', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).getState();
    expect(http.requestRaw).toHaveBeenCalledWith('GET', '/api/sync/state', undefined, undefined);
  });

  it('init → PUT，retry=false，newState 已校验', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).init(newState);
    const [method, path, body, opts] = http.requestRaw.mock.calls[0];
    expect(method).toBe('PUT');
    expect(path).toBe('/api/sync/init');
    expect(body.newState).toEqual(newState);
    expect(opts).toEqual({ retry: false });
  });

  it('getRecords → GET with query', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).getRecords('5', '10', 50);
    const [method, path] = http.requestRaw.mock.calls[0];
    expect(method).toBe('GET');
    expect(path).toBe('/api/sync/records?after=5&snapshotSequence=10&limit=50');
  });

  it('resetChallenges → POST，默认重试', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).resetChallenges();
    expect(http.requestRaw).toHaveBeenCalledWith('POST', '/api/sync/reset-challenges', undefined, undefined);
  });

  it('resetAfterLoss → POST，retry=false', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).resetAfterLoss('A'.repeat(43), newState);
    const [method, path, body, opts] = http.requestRaw.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api/sync/reset-after-loss');
    expect(body).toEqual({
      protocolVersion: 1,
      resetToken: 'A'.repeat(43),
      confirmIrreversible: true,
      confirmDataLoss: true,
      confirmNoRecovery: true,
      newState,
    });
    expect(opts).toEqual({ retry: false });
  });
});

describe('PersonalSyncClient 签名方法', () => {
  it('putRecord → PUT path + body 含 86 字符 signature', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).putRecord({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), recordId: 'A'.repeat(22), baseVersion: '0',
      nonce: 'A'.repeat(16), ciphertext: 'YQ', tag: 'A'.repeat(22), seed: seed(),
    });
    const [method, path, body, opts] = http.requestRaw.mock.calls[0];
    expect(method).toBe('PUT');
    expect(path).toBe(`/api/sync/records/${'A'.repeat(22)}`);
    expect(body.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(opts).toBeUndefined();
  });

  it('deleteRecord → DELETE path', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).deleteRecord({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), recordId: 'A'.repeat(22), baseVersion: '3', seed: seed(),
    });
    expect(http.requestRaw.mock.calls[0][1]).toBe(`/api/sync/records/${'A'.repeat(22)}`);
  });

  it('changeKey → POST，签名字段集正确', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).changeKey({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), expectedStateVersion: '3', smpKdf, envelopeSmp: envelope, seed: seed(),
    });
    const [method, path, body] = http.requestRaw.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api/sync/change-key');
    expect(body).toHaveProperty('signature');
    expect(body).not.toHaveProperty('requestDigest');
  });

  it('recover → POST /api/sync/recover', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).recover({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), expectedStateVersion: '3',
      smpKdf, envelopeSmp: envelope, recoveryKdf, envelopeRecovery: envelope, recoverSignPub: 'A'.repeat(43), seed: seed(),
    });
    expect(http.requestRaw.mock.calls[0][1]).toBe('/api/sync/recover');
  });

  it('destroy → POST /api/sync/destroy', async () => {
    const http = makeHttp();
    await new PersonalSyncClient(http).destroy({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), expectedStateVersion: '3', newState, seed: seed(),
    });
    expect(http.requestRaw.mock.calls[0][1]).toBe('/api/sync/destroy');
  });
});

describe('PersonalSyncClient 错误与校验', () => {
  it('非 2xx 抛 SyncApiError（含 code）', async () => {
    const http = { requestRaw: vi.fn(async () => ({ status: 409, body: { code: 'SYNC_VERSION_CONFLICT', message: 'x' } })) } as any;
    await expect(new PersonalSyncClient(http).getState()).rejects.toMatchObject({ status: 409, code: 'SYNC_VERSION_CONFLICT' });
  });

  it('非法 u64（前导零）拒绝', async () => {
    await expect(new PersonalSyncClient(makeHttp()).deleteRecord({
      userId: '7', keyEpoch: '01', mutationId: 'A'.repeat(22), recordId: 'A'.repeat(22), baseVersion: '3', seed: seed(),
    })).rejects.toThrowError(/keyEpoch/);
  });

  it('超 u64 拒绝', async () => {
    await expect(new PersonalSyncClient(makeHttp()).deleteRecord({
      userId: '7', keyEpoch: '18446744073709551616', mutationId: 'A'.repeat(22), recordId: 'A'.repeat(22), baseVersion: '3', seed: seed(),
    })).rejects.toThrowError(/u64/);
  });

  it('非法 newState（嵌套 smpKdf 错误）拒绝且不发请求', async () => {
    const http = makeHttp();
    await expect(new PersonalSyncClient(http).init({ ...newState, smpKdf: { ...smpKdf, memoryKiB: 1024 } })).rejects.toThrowError(/memoryKiB/);
    expect(http.requestRaw).not.toHaveBeenCalled();
  });

  it('带 padding 的 mutationId 拒绝', async () => {
    await expect(new PersonalSyncClient(makeHttp()).deleteRecord({
      userId: '7', keyEpoch: '1', mutationId: `${'A'.repeat(22)}=`, recordId: 'A'.repeat(22), baseVersion: '3', seed: seed(),
    })).rejects.toThrowError(/unpadded base64url/);
  });
});
