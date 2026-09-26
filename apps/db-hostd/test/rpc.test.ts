import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileMemento, FileSecureStorage } from '../src/ports.js';
import { createHandlers, dispatch, type HandlerMap } from '../src/rpc.js';

let dir: string;
let handlers: HandlerMap;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'db-hostd-'));
  handlers = createHandlers({
    secrets: new FileSecureStorage(join(dir, 'secrets.json')),
    memento: new FileMemento(join(dir, 'memento.json')),
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const call = (method: string, params?: Record<string, unknown>) => dispatch(handlers, { id: 1, method, params });

describe('db-hostd RPC 分发', () => {
  it('ping', async () => {
    await expect(call('ping')).resolves.toEqual({ id: 1, result: 'pong' });
  });

  it('未知方法 → RpcFailure 而非抛出', async () => {
    const res = (await call('nope')) as { error: { code: number; message: string } };
    expect(res.error.code).toBe(-32000);
    expect(res.error.message).toMatch(/unknown method/);
  });

  it('缺少必填参数 → RpcFailure', async () => {
    const res = (await call('dek.load', { userId: 'u1' })) as { error: { message: string } };
    expect(res.error.message).toMatch(/keyEpoch/);
  });

  it('dek 生命周期（generate/store/load/delete）经 SecureStorageLike 端口', async () => {
    const gen = (await call('dek.generate')) as { result: { dek: string } };
    const dek = gen.result.dek;
    expect(dek).toMatch(/^[A-Za-z0-9_-]+$/);

    await expect(call('dek.store', { userId: 'u1', keyEpoch: '3', dek })).resolves.toEqual({
      id: 1,
      result: { ok: true },
    });
    await expect(call('dek.load', { userId: 'u1', keyEpoch: 3 })).resolves.toEqual({ id: 1, result: { dek } });
    await expect(call('dek.delete', { userId: 'u1', keyEpoch: '3' })).resolves.toEqual({
      id: 1,
      result: { ok: true },
    });
    await expect(call('dek.load', { userId: 'u1', keyEpoch: '3' })).resolves.toEqual({ id: 1, result: { dek: null } });
  });

  it('权益门禁：无权益 fail-closed，Pro 放行 postgresql', async () => {
    await expect(call('entitlement.allowedEngines')).resolves.toMatchObject({
      result: { engines: ['mysql', 'sqlite', 'redis'], domain: 'devbelt/sync/v1' },
    });
    const pro = { planCode: 'pro', allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 5, maxSavedConnections: 100, allowConnectionImport: true };
    const res = (await call('entitlement.allowedEngines', { entitlement: pro })) as { result: { engines: string[] } };
    expect(res.result.engines).toContain('postgresql');
  });

  it('签名输入构造与签名（复用 db-host crypto）', async () => {
    const gen = (await call('dek.generate')) as { result: { dek: string } };
    const params = {
      action: 'state.destroy',
      userId: '7',
      keyEpoch: '1',
      expectedStateVersion: '1',
      mutationId: 'AAAAAAAAAAAAAAAAAAAAAA',
      requestDigest: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      dek: gen.result.dek,
    };
    const input = (await call('sign.stateInput', params)) as { result: { input: { domain: string } } };
    expect(input.result.input.domain).toBe('devbelt/sync/v1');

    const signed = (await call('sign.signInput', params)) as { result: { signature: string } };
    expect(signed.result.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it('sign.requestDigest 与签名可串联', async () => {
    const body = { protocolVersion: 1, keyEpoch: '1', mutationId: 'm', expectedStateVersion: '3' };
    const res = (await call('sign.requestDigest', { body })) as { result: { digest: string } };
    expect(res.result.digest).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('db-hostd sync.getMe（本地 HTTP 桩，复用 SyncClient）', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/api/db/me') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ user: { id: 'u1' }, plan: 'free' }));
        return;
      }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('返回 /api/db/me 的 JSON', async () => {
    const res = (await call('sync.getMe', { baseUrl, accessToken: 'A1' })) as { result: { user: { id: string } } };
    expect(res.result.user.id).toBe('u1');
  });
});