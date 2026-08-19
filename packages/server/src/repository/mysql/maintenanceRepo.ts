import type { IMaintenanceRepo, PruneResult } from '../interfaces.js';
import type { MysqlDb } from './db.js';

/**
 * 一次 DELETE 的行数上限。
 *
 * 事件表在几个月不清理后可能积到几十万甚至上百万行，一条无 LIMIT 的
 * `DELETE FROM sync_events WHERE create_time < ?` 会：
 *  - 在一个隐式事务里锁住所有匹配行（其他写入排队）；
 *  - 把整批 undo log 攒在内存/表空间里；
 *  - 生成一个巨大的 binlog 事件，主从延迟直接窜上去。
 * 分批删除让每一批都是短事务，中间给别的语句留出缝隙。
 */
export const PRUNE_BATCH = 2000;

/**
 * 单表单轮的最大批次数。
 *
 * 没有上限的话，第一次在积压严重的库上跑清理会一直循环删同一张表，
 * 长时间独占一条池连接；下一轮（默认 24h 后）会接着删，最终收敛。
 * 上限也保证一张异常膨胀的表不会把其他表的清理饿死。
 */
const MAX_BATCHES_PER_TABLE = 100;

/**
 * 按 create_time 清理的事件/留痕表。
 *
 * 这些表只用于「看趋势 / 事后排查」，没有任何业务逻辑读取历史行，
 * 所以可以按时间无条件删。
 *
 * 刻意**不含** traffic_stats：那张表是小时粒度聚合，容量上限约每天 3240 行
 * （27 路由 × 5 状态类 × 24 桶），几年都不值得清理，见 schema.ts 的说明。
 *
 * 也**不含** admin_audit_log：审计留痕的价值随时间增长而非衰减，且写入频率
 * 极低（只有管理操作），涨不起来。
 *
 * webhook_events 在列：它只用于去重，保留期（默认 90 天）远超所有支付商的
 * 重试窗口（Stripe 最长 3 天），过期记录没有价值。
 */
const EVENT_TABLES = ['sync_events', 'usage_events', 'device_events', 'traffic_blocked', 'webhook_events'] as const;

/** 运维清理仓储：事件表按保留期删除 + 过期会话行回收 */
export class MysqlMaintenanceRepo implements IMaintenanceRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async pruneEvents(retentionDays: number, now: Date = new Date()): Promise<PruneResult> {
    const result: PruneResult = { deleted: {}, errors: [], total: 0 };
    // 0 / 负数 = 关闭清理。让运维能在排查期间保住全部留痕
    if (retentionDays <= 0) return result;

    const cutoff = new Date(now.getTime() - retentionDays * 86400_000);

    for (const table of EVENT_TABLES) {
      await this.pruneTable(
        result,
        table,
        `DELETE FROM ${table} WHERE create_time < ? LIMIT ?`,
        (limit) => [cutoff, limit],
      );
    }

    /**
     * refresh_tokens 的条件比事件表严得多。
     *
     * 只删「已经失效」的行：仍然有效的会话被删掉等于把用户静默踢下线。
     * 而且要过了保留期才删 —— 刚撤销的行是 token 重用检测的依据
     * （`consume` 发现行已撤销就判定重用并全撤销），删早了检测就失灵。
     * 用 cutoff 同时约束 expires_time 与 revoked_time，两者都不为 NULL 时
     * 取更晚的那个（COALESCE 顺序无所谓，因为都要小于 cutoff）。
     */
    await this.pruneTable(
      result,
      'refresh_tokens',
      `DELETE FROM refresh_tokens
        WHERE (expires_time < ? OR revoked_time < ?)
          AND (revoked_time IS NULL OR revoked_time < ?)
          AND expires_time < ?
        LIMIT ?`,
      (limit) => [cutoff, cutoff, cutoff, cutoff, limit],
    );

    return result;
  }

  /**
   * 反复执行同一条分批 DELETE 直到某批不满（说明删完了）或撞上批次上限。
   * 单表出错只记录不抛：一张表的问题（比如被 DDL 锁住）不该让整轮清理停摆。
   */
  private async pruneTable(
    result: PruneResult,
    table: string,
    sql: string,
    params: (limit: number) => any[],
  ): Promise<void> {
    let deleted = 0;
    try {
      for (let i = 0; i < MAX_BATCHES_PER_TABLE; i++) {
        const [r] = await this.db().query<any>(sql, params(PRUNE_BATCH));
        const n = r?.affectedRows ?? 0;
        deleted += n;
        if (n < PRUNE_BATCH) break;
      }
    } catch (err) {
      result.errors.push({ table, error: err instanceof Error ? err : new Error(String(err)) });
    }
    result.deleted[table] = deleted;
    result.total += deleted;
  }
}
