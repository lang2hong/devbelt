import { describe, expect, it } from 'vitest';
import * as e2ee from './index';
import { unlockDekBrowser } from './unlock';

/**
 * P6-S5c：浏览器主 bundle 的打包隔离护栏。
 *
 * `db-host/sync/crypto/argon2.ts` 的约定是「执行体只在 Worker 内调用」。一旦有人把
 * `export * from './argon2'` 加回 e2ee barrel，或给 `unlockDekBrowser` 的 `deriveKek`
 * 恢复默认实现，`hash-wasm` 就会被静态拉进主线程 bundle（且 CI 不会报错）。这两个
 * 断言用最小成本把该约定钉死。
 */
describe('P6-S5c e2ee barrel isolation', () => {
  it('does not re-export the Argon2 execution body from the barrel', () => {
    expect('deriveKekSmp' in e2ee).toBe(false);
  });

  it('requires an injected KDF (no default parameter that imports hash-wasm)', () => {
    // 6 个必填参数；一旦恢复默认实现，Function.length 会降为 5。
    expect(unlockDekBrowser.length).toBe(6);
  });
});
