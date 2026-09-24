/**
 * Argon2id 执行体透出（P6-S5c）：仅供 db-ui 的 Web Worker 调用。
 * 主线程不得直接执行；WASM 计算必须在 Worker 内。
 */
export { deriveKekSmp } from '@devbelt/db-host/sync/crypto/argon2';
export { assertSmpKdfParams, type SmpKdfParams } from '@devbelt/db-host/sync/crypto/smpKdfParams';
