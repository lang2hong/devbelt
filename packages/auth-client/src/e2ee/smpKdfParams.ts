/**
 * SMP KDF 参数类型与校验（P6-S5c）：与执行体解耦，不含 `hash-wasm`，可安全进入主 barrel。
 * 主线程（db-ui 页面 / Worker 门面）据此校验服务端 `smpKdf`，在转发给 Worker 前无需 KDF 开销。
 */
export { assertSmpKdfParams, type SmpKdfParams } from '@devbelt/db-host/sync/crypto/smpKdfParams';

export type { EnvelopeDto } from '@devbelt/db-host/sync/e2e/types';
