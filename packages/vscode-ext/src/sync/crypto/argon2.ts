import { argon2id } from 'hash-wasm';

/**
 * Argon2id KDF（§8.1.2 的 KEK_smp 派生）。
 *
 * 参数范围冻结于 §8.1.2：memory ∈ [65536, 262144] KiB、iterations ∈ [3, 10]、
 * parallelism ∈ [1, 4]、salt 16B、output 32B。任何越界值 fail-closed 拒绝。
 *
 * 注意：argon2id 是 memory-hard，计算在 WASM 上同步执行（Promise 只是接口）。
 * 派生耗时较高，生产调用点（B3/B4 解 enroll/解锁 SMP）需放到 worker 或后台，
 * 避免阻塞扩展主进程——此约束在 B1 仅交付 async 接口，worker 化归 B3/B4。
 */

export const ARGON2ID_ALG = 'argon2id' as const;
export const ARGON2ID_VERSION = 1;
export const ARGON2ID_SALT_BYTES = 16;
export const ARGON2ID_OUTPUT_BYTES = 32;

export const ARGON2ID_MEMORY_MIN_KIB = 65536;
export const ARGON2ID_MEMORY_MAX_KIB = 262144;
export const ARGON2ID_ITERATIONS_MIN = 3;
export const ARGON2ID_ITERATIONS_MAX = 10;
export const ARGON2ID_PARALLELISM_MIN = 1;
export const ARGON2ID_PARALLELISM_MAX = 4;

export interface SmpKdfParams {
  alg: 'argon2id';
  version: 1;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
  outputBytes: 32;
}

export function assertSmpKdfParams(p: SmpKdfParams): void {
  if (p.alg !== ARGON2ID_ALG) throw new Error(`unsupported SMP KDF alg: ${p.alg}`);
  if (p.version !== ARGON2ID_VERSION) throw new Error(`unsupported SMP KDF version: ${p.version}`);
  if (p.salt.length !== ARGON2ID_SALT_BYTES) {
    throw new Error(`SMP KDF salt must be ${ARGON2ID_SALT_BYTES} bytes, got ${p.salt.length}`);
  }
  if (p.outputBytes !== ARGON2ID_OUTPUT_BYTES) {
    throw new Error(`SMP KDF output must be ${ARGON2ID_OUTPUT_BYTES} bytes, got ${p.outputBytes}`);
  }
  if (p.memoryKiB < ARGON2ID_MEMORY_MIN_KIB || p.memoryKiB > ARGON2ID_MEMORY_MAX_KIB) {
    throw new Error(`SMP KDF memoryKiB out of range [${ARGON2ID_MEMORY_MIN_KIB}, ${ARGON2ID_MEMORY_MAX_KIB}]: ${p.memoryKiB}`);
  }
  if (p.iterations < ARGON2ID_ITERATIONS_MIN || p.iterations > ARGON2ID_ITERATIONS_MAX) {
    throw new Error(`SMP KDF iterations out of range [${ARGON2ID_ITERATIONS_MIN}, ${ARGON2ID_ITERATIONS_MAX}]: ${p.iterations}`);
  }
  if (p.parallelism < ARGON2ID_PARALLELISM_MIN || p.parallelism > ARGON2ID_PARALLELISM_MAX) {
    throw new Error(`SMP KDF parallelism out of range [${ARGON2ID_PARALLELISM_MIN}, ${ARGON2ID_PARALLELISM_MAX}]: ${p.parallelism}`);
  }
}

/** 由 SMP 派生 KEK_smp（32B）。参数越界抛错。 */
export async function deriveKekSmp(smp: string, params: SmpKdfParams): Promise<Uint8Array> {
  assertSmpKdfParams(params);
  const out = await argon2id({
    password: smp,
    salt: params.salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: params.outputBytes,
    outputType: 'binary',
  });
  return new Uint8Array(out);
}