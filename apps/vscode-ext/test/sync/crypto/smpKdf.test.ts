import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { deriveKekSmpInWorker, type WorkerLike } from '@devbelt/db-host/sync/crypto/smpKdf';
import { deriveKekSmp } from '@devbelt/db-host/sync/crypto/argon2';
import { ARGON2ID_SALT_BYTES, type SmpKdfParams } from '@devbelt/db-host/sync/crypto/smpKdfParams';
import { encodeBase64Url } from '@devbelt/db-host/sync/crypto/recoveryCode';

const valid: SmpKdfParams = {
  alg: 'argon2id',
  version: 1,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  salt: new Uint8Array(ARGON2ID_SALT_BYTES).fill(1),
  outputBytes: 32,
};

class FakeWorker implements WorkerLike {
  private readonly handlers = new Map<string, ((arg: unknown) => void)[]>();
  posted: unknown;
  terminated = false;

  constructor(private readonly onPost: (msg: { smp: string; params: SmpKdfParams }) => void) {}

  postMessage(value: unknown): void {
    this.posted = value;
    this.onPost(value as { smp: string; params: SmpKdfParams });
  }

  once(event: string, cb: (arg: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) cb(arg);
  }
}

const itIfWorkerBuilt = existsSync(join(__dirname, '../../../out/argon2Worker.js')) ? it : it.skip;

describe('deriveKekSmpInWorker', () => {
  it('spawn 抛错 → fail-closed（拒绝解锁）', async () => {
    await expect(deriveKekSmpInWorker('smp', valid, {
      spawnWorker: () => { throw new Error('no worker thread'); },
    })).rejects.toThrowError(/Argon2id Worker unavailable/);
  });

  it('worker 返回 KEK → 解析并终止 worker', async () => {
    const kek = new Uint8Array(32).fill(7);
    const fake = new FakeWorker(() => {
      setTimeout(() => fake.emit('message', { ok: true, result: encodeBase64Url(kek) }), 0);
    });
    const out = await deriveKekSmpInWorker('smp', valid, { spawnWorker: () => fake });
    expect(Buffer.from(out).toString('hex')).toBe(Buffer.from(kek).toString('hex'));
    const posted = fake.posted as { smp: string; params: SmpKdfParams };
    expect(posted.smp).toBe('smp');
    expect(posted.params).toEqual(valid);
    expect(fake.terminated).toBe(true);
  });

  it('worker 报错 → reject（error 不含 smp）', async () => {
    const fake = new FakeWorker(() => {
      setTimeout(() => fake.emit('message', { ok: false, error: 'bad kdf params' }), 0);
    });
    await expect(deriveKekSmpInWorker('smp', valid, { spawnWorker: () => fake })).rejects.toThrowError(/bad kdf params/);
    expect(fake.terminated).toBe(true);
  });

  it('worker 返回损坏 KEK → reject', async () => {
    const fake = new FakeWorker(() => {
      setTimeout(() => fake.emit('message', { ok: true, result: 'AAAA' }), 0);
    });
    await expect(deriveKekSmpInWorker('smp', valid, { spawnWorker: () => fake })).rejects.toThrowError(/corrupt KEK|wrong KEK length/);
  });

  it('worker 返回 null / 非对象 / 无 ok 字段 → reject invalid response', async () => {
    for (const bad of [null, 'x', 42, {}]) {
      const fake = new FakeWorker(() => {
        setTimeout(() => fake.emit('message', bad), 0);
      });
      await expect(deriveKekSmpInWorker('smp', valid, { spawnWorker: () => fake })).rejects.toThrowError(/invalid response/);
    }
  });

  it('超时且 worker 不回消息 → reject /timed out/ 且 terminate', async () => {
    const fake = new FakeWorker(() => { /* 不回消息 */ });
    await expect(deriveKekSmpInWorker('smp', valid, { spawnWorker: () => fake, timeoutMs: 1 })).rejects.toThrowError(/timed out/);
    expect(fake.terminated).toBe(true);
  });

  it('未回消息即退出（code 0）→ reject /exited before response/', async () => {
    const fake = new FakeWorker(() => {
      setTimeout(() => fake.emit('exit', 0), 0);
    });
    await expect(deriveKekSmpInWorker('smp', valid, { spawnWorker: () => fake })).rejects.toThrowError(/exited before response/);
  });

  itIfWorkerBuilt('真实 worker：默认 spawn 输出与执行体逐字节一致', async () => {
    // 注意：此处仅在测试主线程调用 deriveKekSmp 以取得 oracle（KAT），
    // 生产代码不得在 src 主线程调用它（§7.1 红线：Argon2id 只在 Worker 执行）。
    const viaWorker = await deriveKekSmpInWorker('smp-password', valid);
    const direct = await deriveKekSmp('smp-password', valid);
    expect(Buffer.from(viaWorker).toString('hex')).toBe(Buffer.from(direct).toString('hex'));
  }, 60000);
});