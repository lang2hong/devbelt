import type { Migration } from '../migrate.js';

/**
 * 回执时间戳一致性（P4 切片复审）：给 personal_sync_mutations 增加
 * `result_recovery_code_set_time`，让 `recover` / `recover-by-account` 在回执里固化
 * 「该次 mutation 落实的恢复码设置时间」，重放时原样返回，而不是读当前 state 混入
 * 后来 operation 的时间戳。
 *
 * 幂等守卫：逐列查 information_schema，已存在则跳过（兼容 DDL 隐式提交的部分执行）。
 */
export const syncMutationRecoveryTimeMigration: Migration = {
  version: '024_sync_mutation_recovery_time',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_sync_mutations'
         AND COLUMN_NAME = 'result_recovery_code_set_time'`,
    ) as [Array<{ COLUMN_NAME: string }>, unknown];
    if (cols.length > 0) return;

    await db.query(
      `ALTER TABLE personal_sync_mutations ADD COLUMN result_recovery_code_set_time DATETIME(3) NULL`,
    );
  },
};