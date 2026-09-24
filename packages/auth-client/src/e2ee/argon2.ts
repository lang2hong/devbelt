/**
 * Argon2id **执行体**（P6-S5c）：Worker-only 子路径（`@devbelt/auth-client/e2ee/argon2`）。
 *
 * 刻意**不进入** `e2ee/index` 主 barrel：任何主线程 import 都会把 `hash-wasm` 静态
 * 打进主 bundle，破坏 `db-host/sync/crypto/argon2.ts` 的打包隔离红线。
 * 目前唯一允许的导入方是 `apps/db-ui/src/workers/argon2.worker.ts`。
 */
export { deriveKekSmp } from '@devbelt/db-host/sync/crypto/argon2';
