/// <reference lib="webworker" />
import { deriveKekSmp, assertSmpKdfParams, type SmpKdfParams } from '@devbelt/auth-client';

/**
 * Argon2id KDF Worker（P6-S5c）：主线程只传 SMP + 参数，WASM 计算在 Worker 内执行。
 */
interface Req { smp: string; params: SmpKdfParams }

(self as unknown as { onmessage: ((e: MessageEvent) => void) | null }).onmessage = (e: MessageEvent): void => {
  const { smp, params } = e.data as Req;
  void (async () => {
    try {
      assertSmpKdfParams(params);
      const kek = await deriveKekSmp(smp, params);
      (self as unknown as { postMessage(v: unknown): void }).postMessage({ ok: true, kek });
    } catch (err) {
      (self as unknown as { postMessage(v: unknown): void }).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};
