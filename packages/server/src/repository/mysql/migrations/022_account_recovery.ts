import type { Migration } from '../migrate.js';

const RECOVERY_COLUMNS = [
  'envelope_account_version', 'envelope_account_nonce',
  'envelope_account_ct', 'envelope_account_tag', 'account_recovery_key',
] as const;

async function existingRecoveryColumns(db: Parameters<Migration['up']>[0]): Promise<Set<string>> {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_sync_state'
       AND COLUMN_NAME IN (${RECOVERY_COLUMNS.map(() => '?').join(', ')})`,
    [...RECOVERY_COLUMNS],
  ) as [Array<{ COLUMN_NAME: string }>, unknown];
  return new Set(rows.map((r) => r.COLUMN_NAME));
}

/**
 * 账号恢复通道（P4 §邮箱恢复，折中方案）：给 personal_sync_state 增加第三信封
 * `envelope_account`（用账号恢复钥匙 KEK_account 包裹 DEK 的密文）与托管钥匙
 * `account_recovery_key`（32B 明文）。
 *
 * - 服务端零知识被有意削弱：持有 account_recovery_key + envelope_account 即可解开
 *   DEK，这是「忘记口令+恢复码仍可通过登录/邮箱找回而恢复」的必然代价。
 * - 新列一律 NOT NULL：账号恢复通道为必填单一契约（无「未启用」态），init 起恒写入。
 * - 守卫：逐列查 information_schema，已存在则跳过（兼容 DDL 隐式提交的部分执行）。
 * - 并发多实例防御：`runMigrations` 本身不加迁移锁，若两个进程同时判定「未应用」
 *   并同时执行本迁移，会有一个 ALTER 成功、另一个撞上 ER_DUP_FIELDNAME（1060）。
 *   捕获该错误后重新查 information_schema：若全部目标列已存在（即另一进程已
 *   完成同等变更），视为本迁移成功放行；否则说明是真实的列名冲突或其他故障，
 *   原样抛出。
 */
export const accountRecoveryMigration: Migration = {
  version: '022_account_recovery',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    const existingColumns = await existingRecoveryColumns(db);
    const addColumns: string[] = [];
    if (!existingColumns.has('envelope_account_version')) addColumns.push('ADD COLUMN envelope_account_version BIGINT UNSIGNED NOT NULL');
    if (!existingColumns.has('envelope_account_nonce')) addColumns.push('ADD COLUMN envelope_account_nonce BINARY(12) NOT NULL');
    if (!existingColumns.has('envelope_account_ct')) addColumns.push('ADD COLUMN envelope_account_ct BINARY(32) NOT NULL');
    if (!existingColumns.has('envelope_account_tag')) addColumns.push('ADD COLUMN envelope_account_tag BINARY(16) NOT NULL');
    if (!existingColumns.has('account_recovery_key')) addColumns.push('ADD COLUMN account_recovery_key BINARY(32) NOT NULL');
    if (addColumns.length === 0) return;

    try {
      await db.query(`ALTER TABLE personal_sync_state ${addColumns.join(', ')}`);
    } catch (e: any) {
      if (e?.code !== 'ER_DUP_FIELDNAME' && e?.errno !== 1060) throw e;
      // 另一实例已并发完成等价变更：复核全部目标列确已存在才放行，避免把
      // 「真实的列名冲突/权限问题」误当作并发竞态吞掉。
      const after = await existingRecoveryColumns(db);
      const stillMissing = RECOVERY_COLUMNS.filter((c) => !after.has(c));
      if (stillMissing.length > 0) throw e;
    }
  },
};