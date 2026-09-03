/**
 * Argon2id KDF 参数域（与执行解耦，不引入 hash-wasm）。
 *
 * 主线程门面（`smpKdf.ts`）在把请求转发给 Worker 前，需要校验参数而不需要执行 KDF，
 * 因此把参数常量和校验单独放本模块，避免主线程 import `hash-wasm`。执行体 `deriveKekSmp`
 * 仍在 `argon2.ts`，只在 Worker 内调用。
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