export interface InvitationCleanupOptions {
  /** 清理周期（毫秒）。默认 15 分钟（§4.3）。 */
  intervalMs?: number;
}

/**
 * 受控邀请过期清理任务（实施规格 §4.3/§4.7：过期邀请由受控清理任务释放容量，
 * 不依赖成员再次操作）。
 *
 * 过期处理的事务协调在 OrganizationService.expireInvitations()（按组织维度锁
 * 组织+订阅），本任务只负责周期触发。
 *
 * - 幂等：expire 按未终结邀请过滤，重复执行无副作用。
 * - 失败仅记录日志，不中断服务；下次周期重试。
 * - `timer.unref()` 使任务不阻塞进程退出。
 */
export function startInvitationCleanup(expire: () => Promise<void>, opts: InvitationCleanupOptions = {}): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 15 * 60 * 1000;

  const run = (): void => {
    expire().catch((err) => {
      console.warn('[invitation] cleanup failed', String(err));
    });
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}