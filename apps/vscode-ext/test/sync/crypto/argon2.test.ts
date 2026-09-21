import { describe, expect, it } from 'vitest';
import { deriveKekSmp } from '@devbelt/db-host/sync/crypto/argon2';
import {
  ARGON2ID_SALT_BYTES,
  assertSmpKdfParams,
  type SmpKdfParams,
} from '@devbelt/db-host/sync/crypto/smpKdfParams';

const valid: SmpKdfParams = {
  alg: 'argon2id',
  version: 1,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  salt: new Uint8Array(ARGON2ID_SALT_BYTES).fill(1),
  outputBytes: 32,
};

describe('argon2', () => {
  it('合法参数通过', () => {
    expect(() => assertSmpKdfParams(valid)).not.toThrow();
  });

  it('memoryKiB 越界拒绝', () => {
    expect(() => assertSmpKdfParams({ ...valid, memoryKiB: 1024 })).toThrowError(/memoryKiB/);
    expect(() => assertSmpKdfParams({ ...valid, memoryKiB: 999999 })).toThrowError(/memoryKiB/);
  });

  it('iterations 越界拒绝', () => {
    expect(() => assertSmpKdfParams({ ...valid, iterations: 1 })).toThrowError(/iterations/);
    expect(() => assertSmpKdfParams({ ...valid, iterations: 99 })).toThrowError(/iterations/);
  });

  it('parallelism 越界拒绝', () => {
    expect(() => assertSmpKdfParams({ ...valid, parallelism: 0 })).toThrowError(/parallelism/);
    expect(() => assertSmpKdfParams({ ...valid, parallelism: 8 })).toThrowError(/parallelism/);
  });

  it('非安全整数（浮点/NaN/Infinity）拒绝', () => {
    expect(() => assertSmpKdfParams({ ...valid, memoryKiB: 65536.5 })).toThrowError(/memoryKiB/);
    expect(() => assertSmpKdfParams({ ...valid, iterations: NaN })).toThrowError(/iterations/);
    expect(() => assertSmpKdfParams({ ...valid, parallelism: Infinity })).toThrowError(/parallelism/);
  });

  it('salt 长度错误拒绝', () => {
    expect(() => assertSmpKdfParams({ ...valid, salt: new Uint8Array(15) })).toThrowError(/salt/);
  });

  it('deriveKekSmp 确定性（最小 cost：65536 KiB / 3 / 1）', async () => {
    const a = await deriveKekSmp('smp-password', valid);
    const b = await deriveKekSmp('smp-password', valid);
    expect(a.length).toBe(32);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });
});