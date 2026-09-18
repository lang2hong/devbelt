import { argon2id } from 'hash-wasm';
import { assertSmpKdfParams, type SmpKdfParams } from './smpKdfParams.js';

/**
 * Argon2id KDF 执行体，用于派生 KEK_smp。
 *
 * 底层在 WASM 上同步计算，仍会阻塞调用线程。解锁 SMP **必须在 Worker 中执行**；本模块
 * 只应在 `argon2Worker.ts`（worker 线程）内被调用，不得接入扩展主线程的运行时调用点。
 * 参数校验已抽到 `smpKdfParams.ts`，供主线程门面在转发前无 KDF 开销地校验。
 * 本模块只导出 `deriveKekSmp`，且只有 `argon2Worker.ts` 一个导入方（打包隔离红线）。
 */

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