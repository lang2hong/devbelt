import type { IMaintenanceRepo } from './repository/interfaces.js';

export { PRUNE_BATCH } from './repository/mysql/maintenanceRepo.js';

/** 只用到这三个级别；FastifyBaseLogger 与测试桩都满足 */
type MaintenanceLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export interface MaintenanceOptions {
  repo: IMaintenanceRepo;
  log: MaintenanceLogger;
  /** 事件表保留天数；<= 0 表示关闭清理 */
  retentionDays: number;
  /** 两轮清理之间的间隔（毫秒） */
  intervalMs: number;
}

/**
 * 启动周期性清理任务，返回停止函数。
 *
 * 为什么需要它：sync_events 每次 pull/push 一行。一个开着自动同步的客户端
 * 按 5 分钟一轮、每轮 5 个 section 算，就是每小时 60 行；100 个用户一天
 * 约 14 万行。这几张表没有任何业务逻辑读历史行，却会无限增长到把磁盘吃满
 * ——「服务好好的，突然写不进去了」是这种问题最典型的表现形式。
 *
 * 三个实现细节都不是可选的：
 *
 * 1. **`unref()`**。24 小时间隔的 interval 会让 Node 事件循环永远有活儿，
 *    正常退出（含 vitest 跑完）会挂住。unref 后它不再计入「保持进程存活」
 *    的引用，但只要进程还在就照常触发。
 * 2. **回调里吞掉错误**。定时器回调里的未捕获 rejection 按 Node 默认的
 *    `--unhandled-rejections=throw` 会直接终止进程：一次 DB 抖动就能把
 *    整个服务干掉。清理失败无非是这轮没删，下一轮再来。
 * 3. **立即跑一轮**。不然进程如果活不到第一个间隔（频繁部署很常见），
 *    清理永远不会发生。
 */
export function startMaintenance(opts: MaintenanceOptions): () => void {
  const { repo, log, retentionDays, intervalMs } = opts;
  if (retentionDays <= 0) {
    log.info({ retentionDays }, 'maintenance: event pruning disabled');
    return () => {};
  }

  const runOnce = async () => {
    try {
      const res = await repo.pruneEvents(retentionDays, new Date());
      for (const { table, error } of res.errors) {
        log.warn({ err: error, table }, 'maintenance: prune failed for table');
      }
      if (res.total > 0) log.info({ deleted: res.deleted, total: res.total }, 'maintenance: pruned old events');
    } catch (err) {
      log.warn({ err }, 'maintenance: prune round failed');
    }
  };

  void runOnce();
  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  timer.unref();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
