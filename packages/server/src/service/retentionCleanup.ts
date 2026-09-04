import type { Queryable } from '../repository/mysql/db.js';
import type {
  IRefreshTokenRepo,
  IEmailVerificationTokenRepo,
  ISyncMutationRepo,
  ISyncResetTokenRepo,
} from '../repository/interfaces.js';

/**
 * 过期数据保留清理任务。
 *
 * 起因：全库只有 rate_limit_entries 与 organization_invitations 有清理任务，
 * 而下面这四张表**只增不减**：
 *
 * - `refresh_tokens`：轮换即插新行、旧行只置 revoked_time。access token 15min
 *   过期就轮换一次，单个活跃用户约 2900 行/月。
 * - `personal_sync_mutations`：每条 mutation 一行；它**自带 `expires_time`**，
 *   明显是设计上要清理的，但此前没有任何代码消费该列。
 * - `email_verification_tokens`、`personal_sync_reset_tokens`：同样自带
 *   `expires_time`，同样没人清。
 *
 * 设计要点（与既有的 rateLimitCleanup / invitationCleanup 保持一致）：
 * - 幂等：全部是 `DELETE ... WHERE <时间列> < ?`，重复执行无副作用。
 * - 分批：每张表每轮最多删 `batchSize` 行，避免单条 DELETE 长时间持锁；
 *   删满一批说明还有积压，下一轮继续（不在本轮内循环，避免长时间占用连接）。
 * - 失败只记日志、不中断服务，下个周期自然重试。
 * - `timer.unref()` 使任务不阻塞进程退出。
 * - 首次触发在 +intervalMs（与另两个清理任务一致，不在启动瞬间加压）。
 */
export interface RetentionCleanupOptions {
  /** 清理周期（毫秒）。默认 1 小时。 */
  intervalMs?: number;
  /** 每张表每轮的删除上限。默认 1000。 */
  batchSize?: number;
  /**
   * refresh token 终结后的保留期（毫秒）。默认 7 天。
   * 保留一段时间便于排查「为什么我被登出了」这类问题。
   */
  refreshTokenRetentionMs?: number;
  /** 验证 / reset token 终结后的保留期（毫秒）。默认 24 小时。 */
  tokenRetentionMs?: number;
}

export interface RetentionCleanupDeps {
  refreshTokenRepo: IRefreshTokenRepo;
  emailVerificationTokenRepo: IEmailVerificationTokenRepo;
  syncMutationRepo: ISyncMutationRepo;
  syncResetTokenRepo: ISyncResetTokenRepo;
  /** 无状态仓储（sync 两张表）需要显式连接来源。 */
  exec: () => Queryable;
}

export function startRetentionCleanup(
  deps: RetentionCleanupDeps,
  opts: RetentionCleanupOptions = {},
): { stop(): void; runOnce(): Promise<void> } {
  const intervalMs = opts.intervalMs ?? 3600_000;
  const batchSize = opts.batchSize ?? 1000;
  const refreshRetentionMs = opts.refreshTokenRetentionMs ?? 7 * 86_400_000;
  const tokenRetentionMs = opts.tokenRetentionMs ?? 86_400_000;

  /** 逐表清理；任一表失败不影响其余表。 */
  const runOnce = async (): Promise<void> => {
    const now = Date.now();
    const refreshBefore = new Date(now - refreshRetentionMs);
    const tokenBefore = new Date(now - tokenRetentionMs);
    // receipt 的 expires_time 已经是绝对到期时刻，按当前时间比即可（无需再减保留期）。
    const nowDate = new Date(now);

    const tasks: Array<[string, () => Promise<number>]> = [
      ['refresh_tokens', () => deps.refreshTokenRepo.prune(refreshBefore, batchSize)],
      ['email_verification_tokens', () => deps.emailVerificationTokenRepo.prune(tokenBefore, batchSize)],
      ['personal_sync_mutations', () => deps.syncMutationRepo.prune(deps.exec(), nowDate, batchSize)],
      ['personal_sync_reset_tokens', () => deps.syncResetTokenRepo.prune(deps.exec(), tokenBefore, batchSize)],
    ];

    for (const [table, run] of tasks) {
      try {
        await run();
      } catch (err) {
        // 与另两个清理任务一致：只记日志。注意不要打印 err 本身的 SQL 字段
        // （mysql2 会把内联参数挂在 err.sql 上），故只取消息文本。
        console.warn(`[retention] cleanup failed for ${table}`, String(err instanceof Error ? err.message : err));
      }
    }
  };

  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), runOnce };
}
