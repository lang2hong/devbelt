import { describe, expect, it, vi } from 'vitest';
import { SyncApiError, V3SyncClient } from '../../../src/sync/v3/client';

function makeHttp(status = 200) {
  return { requestRaw: vi.fn(async () => ({ status, body: {} })) } as any;
}

function seed(): Uint8Array {
  return new Uint8Array(32).fill(1);
}

describe('V3SyncClient 无签名方法', () => {
  it('getState → GET /api/sync/state', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).getState();
    expect(http.requestRaw).toHaveBeenCalledWith('GET', '/api/sync/state', undefined, undefined);
  });

  it('init → PUT，retry=false', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).init({} as any);
    const [method, path, body, opts] = http.requestRaw.mock.calls[0];
    expect(method).toBe('PUT');
    expect(path).toBe('/api/sync/init');
    expect(body).toHaveProperty('newState');
    expect(opts).toEqual({ retry: false });
  });

  it('getRecords → GET with query', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).getRecords('5', '10', 50);
    const [method, path] = http.requestRaw.mock.calls[0];
    expect(method).toBe('GET');
    expect(path).toBe('/api/sync/records?after=5&snapshotSequence=10&limit=50');
  });

  it('resetChallenges → POST，默认重试', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).resetChallenges();
    expect(http.requestRaw).toHaveBeenCalledWith('POST', '/api/sync/reset-challenges', undefined, undefined);
  });

  it('resetAfterLoss → POST，retry=false，携带 resetToken + 三个确认', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).resetAfterLoss('A'.repeat(43), {} as any);
    const [method, path, body, opts] = http.requestRaw.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api/sync/reset-after-loss');
    expect(body).toEqual({
      protocolVersion: 1,
      resetToken: 'A'.repeat(43),
      confirmIrreversible: true,
      confirmDataLoss: true,
      confirmNoRecovery: true,
      newState: {},
    });
    expect(opts).toEqual({ retry: false });
  });
});

describe('V3SyncClient 签名方法', () => {
  it('putRecord → PUT path + body 含 86 字符 signature，默认重试', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).putRecord({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), recordId: 'r1', baseVersion: '0',
      nonce: 'A'.repeat(16), ciphertext: 'YQ', tag: 'A'.repeat(22), seed: seed(),
    });
    const [method, path, body, opts] = http.requestRaw.mock.calls[0];
    expect(method).toBe('PUT');
    expect(path).toBe('/api/sync/records/r1');
    expect(body.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(typeof body.protocolVersion).toBe('number');
    expect(opts).toBeUndefined();
  });

  it('deleteRecord → DELETE path', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).deleteRecord({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), recordId: 'r1', baseVersion: '3', seed: seed(),
    });
    const [method, path, body] = http.requestRaw.mock.calls[0];
    expect(method).toBe('DELETE');
    expect(path).toBe('/api/sync/records/r1');
    expect(body).toHaveProperty('signature');
  });

  it('changeKey → POST /api/sync/change-key，签名字段集正确', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).changeKey({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), expectedStateVersion: '3', smpKdf: {}, envelopeSmp: {}, seed: seed(),
    });
    const [method, path, body] = http.requestRaw.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api/sync/change-key');
    expect(body).toHaveProperty('signature');
    expect(body).toHaveProperty('protocolVersion');
    expect(body).not.toHaveProperty('requestDigest'); // requestDigest 不入 body
  });

  it('recover → POST /api/sync/recover', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).recover({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), expectedStateVersion: '3',
      smpKdf: {}, envelopeSmp: {}, recoveryKdf: {}, envelopeRecovery: {}, recoverSignPub: 'A'.repeat(43), seed: seed(),
    });
    expect(http.requestRaw.mock.calls[0][1]).toBe('/api/sync/recover');
  });

  it('destroy → POST /api/sync/destroy', async () => {
    const http = makeHttp();
    await new V3SyncClient(http).destroy({
      userId: '7', keyEpoch: '1', mutationId: 'A'.repeat(22), expectedStateVersion: '3', newState: {} as any, seed: seed(),
    });
    expect(http.requestRaw.mock.calls[0][1]).toBe('/api/sync/destroy');
  });
});

describe('V3SyncClient 错误与校验', () => {
  it('非 2xx 抛 SyncApiError（含 code）', async () => {
    const http = { requestRaw: vi.fn(async () => ({ status: 409, body: { code: 'SYNC_VERSION_CONFLICT', message: 'x' } })) } as any;
    await expect(new V3SyncClient(http).getState()).rejects.toThrowError(SyncApiError);
    await expect(new V3SyncClient(http).getState()).rejects.toMatchObject({ status: 409, code: 'SYNC_VERSION_CONFLICT' });
  });

  it('非法 u64 keyEpoch（前导零）拒绝', async () => {
    const http = makeHttp();
    await expect(new V3SyncClient(http).deleteRecord({
      userId: '7', keyEpoch: '01', mutationId: 'A'.repeat(22), recordId: 'r1', baseVersion: '3', seed: seed(),
    })).rejects.toThrowError(/keyEpoch/);
  });
});