import type { IRateLimitRepo } from '../repository/interfaces.js';

export interface RateLimitCleanupOptions {
  /** 清理周期（毫秒）。默认 5 分钟。 */
  intervalMs?: number;
  /** 保留窗口（毫秒）：只删除 `window_start_time` 早于 `now - retention` 的桶。默认 2 小时，覆盖最长的 1 小时限流窗口。 */
  retentionMs?: number;
}

/**
 * 受控限流清理任务：过期桶由周期任务删除，不依赖请求触发（实施规格 §3 启动顺序）。
 *
 * - 幂等：`DELETE ... WHERE window_start_time < ?`，重复执行无副作用。
 * - 失败仅记录日志，不中断服务；下次周期重试。
 * - `timer.unref()` 使任务不阻塞进程退出。
 */
export function startRateLimitCleanup(repo: IRateLimitRepo, opts: RateLimitCleanupOptions = {}): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  const retentionMs = opts.retentionMs ?? 2 * 3600 * 1000;

  const run = (): void => {
    const before = new Date(Date.now() - retentionMs);
    repo.prune(before).catch((err) => {
      console.warn('[ratelimit] cleanup failed', String(err));
    });
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}