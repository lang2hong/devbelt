import { describe, expect, it, vi } from 'vitest';

/**
 * defaultSpawn 的运行时选项契约（真机事故回归）：
 * worker 若继承父进程 `--inspect-brk`（F5 调试态扩展宿主）会静默挂起，
 * 派生永不回消息 → 30s 超时 → 解锁/账号恢复被误报为"口令不一致"。
 * 本文件 mock worker_threads 捕获构造参数，断言 execArgv 被显式清空。
 */
const created = vi.hoisted(() => [] as Array<{ path: string; options?: { execArgv?: string[] } }>);

vi.mock('worker_threads', () => ({
  Worker: class {
    constructor(path: string, options?: { execArgv?: string[] }) {
      created.push({ path, options });
    }
    once(event: string, cb: (arg: unknown) => void): void {
      if (event === 'message') {
        setImmediate(() => cb({ ok: true, result: Buffer.alloc(32, 9).toString('base64url') }));
      }
    }
    postMessage(): void {}
    terminate(): void {}
  },
}));

import { deriveKekSmpInWorker } from '@devbelt/db-host/sync/crypto/smpKdf';
import { ARGON2ID_SALT_BYTES, type SmpKdfParams } from '@devbelt/db-host/sync/crypto/smpKdfParams';

const valid: SmpKdfParams = {
  alg: 'argon2id',
  version: 1,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  salt: new Uint8Array(ARGON2ID_SALT_BYTES).fill(1),
  outputBytes: 32,
};

describe('defaultSpawn 选项（防 --inspect-brk 继承）', () => {
  it('worker 构造 execArgv 为空数组，且路径指向 argon2Worker.js', async () => {
    const kek = await deriveKekSmpInWorker('smp', valid);
    expect(kek.length).toBe(32);
    expect(created).toHaveLength(1);
    expect(created[0].options?.execArgv).toEqual([]);
    expect(created[0].path.endsWith('argon2Worker.js')).toBe(true);
  });
});
