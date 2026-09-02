import { argon2id } from 'hash-wasm';

/**
 * Argon2id KDF，用于派生 KEK_smp。
 *
 * 参数范围：memory ∈ [65536, 262144] KiB、iterations ∈ [3, 10]、
 * parallelism ∈ [1, 4]、salt 16B、output 32B。任何越界值 fail-closed 拒绝。
 *
 * 本 API 返回 Promise，但底层在 WASM 上同步计算，仍会阻塞调用线程。解锁 SMP
 * 必须在 Worker 中执行；本模块不得接入扩展主线程的运行时调用点。
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
  if (p.alg !== ARGON2ID_ALG) throw new Error(`unsupported SMP KDF alg: ${String(p.alg)}`);
  if (p.version !== ARGON2ID_VERSION) throw new Error(`unsupported SMP KDF version: ${String(p.version)}`);
  if (p.salt.length !== ARGON2ID_SALT_BYTES) {
    throw new Error(`SMP KDF salt must be ${ARGON2ID_SALT_BYTES} bytes, got ${p.salt.length}`);
  }
  if (p.outputBytes !== ARGON2ID_OUTPUT_BYTES) {
    throw new Error(`SMP KDF output must be ${ARGON2ID_OUTPUT_BYTES} bytes, got ${String(p.outputBytes)}`);
  }
  if (!Number.isSafeInteger(p.memoryKiB) || p.memoryKiB < ARGON2ID_MEMORY_MIN_KIB || p.memoryKiB > ARGON2ID_MEMORY_MAX_KIB) {
    throw new Error(`SMP KDF memoryKiB must be a safe integer in [${ARGON2ID_MEMORY_MIN_KIB}, ${ARGON2ID_MEMORY_MAX_KIB}]: ${String(p.memoryKiB)}`);
  }
  if (!Number.isSafeInteger(p.iterations) || p.iterations < ARGON2ID_ITERATIONS_MIN || p.iterations > ARGON2ID_ITERATIONS_MAX) {
    throw new Error(`SMP KDF iterations must be a safe integer in [${ARGON2ID_ITERATIONS_MIN}, ${ARGON2ID_ITERATIONS_MAX}]: ${String(p.iterations)}`);
  }
  if (!Number.isSafeInteger(p.parallelism) || p.parallelism < ARGON2ID_PARALLELISM_MIN || p.parallelism > ARGON2ID_PARALLELISM_MAX) {
    throw new Error(`SMP KDF parallelism must be a safe integer in [${ARGON2ID_PARALLELISM_MIN}, ${ARGON2ID_PARALLELISM_MAX}]: ${String(p.parallelism)}`);
  }
}

/** 由 SMP 派生 KEK_smp（32B）。参数越界抛错。⚠️ 见文件头执行边界。 */
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
