export interface NonceCleanupOptions {
  /** 清理周期（毫秒）。默认 15 分钟。 */
  intervalMs?: number;
}

/**
 * 支付回调 nonce 过期清理任务（复刻 invitationCleanup 的受控调度）。
 *
 * `payment_callback_nonces` 只增不减：每条回调 nonce 一行，30 分钟 TTL 仅用于重放
 * 去重，过期后即垃圾。由周期任务物理删除，不依赖回调再次触发。
 *
 * - 幂等：`DELETE ... WHERE expires_time < NOW()`，重复执行无副作用。
 * - 失败仅记日志、不中断服务；下个周期重试。
 * - 重入闸：上一轮未结束则跳过本轮，避免叠加连接占用。
 * - `timer.unref()` 使任务不阻塞进程退出。
 */
export function startNonceCleanup(purge: () => Promise<void>, opts: NonceCleanupOptions = {}): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 15 * 60 * 1000;

  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await purge();
    } catch (err) {
      console.warn('[payment-nonce] cleanup failed', String(err));
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}