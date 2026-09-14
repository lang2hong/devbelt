import type { Migration } from '../migrate.js';

/**
 * 发票状态机扩展（P4 切片 3 复审）：
 * - 新增 `failed` 态（与 `rejected` 并列，均属终态，需 reason 记录原因）。
 * - 新增 `reason` 列（VARCHAR(500) NULL，仅 rejected/failed 必填，其余为 NULL）。
 *
 * 幂等守卫（兼容 DDL 隐式提交造成的部分执行）：
 * - `reason` 列：逐列查 information_schema，已存在则跳过。
 * - CHECK 约束 `chk_invoices_status`：按三种状态自愈，绝不因「上次 DROP 成功但 ADD 失败」
 *   而卡死后续启动——
 *    1. 约束不存在（含上次 DROP 成功、ADD 未执行）→ 直接 `ADD CONSTRAINT`；
 *    2. 约束存在但 `CHECK_CLAUSE` 不含 `failed` → `DROP CHECK` + `ADD CONSTRAINT`；
 *    3. 约束存在且已含 `failed` → 跳过。
 *   MySQL 8.0.16+ 强制 CHECK，`DROP CHECK symbol` 可用（与建表命名一致）。
 */
export const invoiceStatusReasonMigration: Migration = {
  version: '023_invoice_status_reason',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    const readColumns = async (): Promise<string[]> => {
      const [rows] = await db.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'reason'`,
      ) as [Array<{ COLUMN_NAME: string }>, unknown];
      return rows.map((r) => r.COLUMN_NAME);
    };
    const readClause = async (): Promise<string | null> => {
      const [rows] = await db.query(
        `SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_invoices_status'`,
      ) as [Array<{ CHECK_CLAUSE: string }>, unknown];
      return rows[0]?.CHECK_CLAUSE ?? null;
    };

    const ensure = async (): Promise<void> => {
      if ((await readColumns()).length === 0) {
        await db.query(`ALTER TABLE invoices ADD COLUMN reason VARCHAR(500) NULL`);
      }
      const clause = await readClause();
      const hasFailed = clause !== null && clause.includes("'failed'");
      if (clause === null) {
        await db.query(
          `ALTER TABLE invoices ADD CONSTRAINT chk_invoices_status
           CHECK (status IN ('requested', 'issued', 'rejected', 'failed'))`,
        );
      } else if (!hasFailed) {
        await db.query(`ALTER TABLE invoices DROP CHECK chk_invoices_status`);
        await db.query(
          `ALTER TABLE invoices ADD CONSTRAINT chk_invoices_status
           CHECK (status IN ('requested', 'issued', 'rejected', 'failed'))`,
        );
      }
    };

    try {
      await ensure();
    } catch (e) {
      // 并发多实例：另一实例可能已推进部分/全部 DDL，本实例撞上重复列/约束名等错误。
      // 复核最终态——`reason` 列存在且 CHECK 已含 `failed` 即视为同等结果放行；否则原样抛出。
      const ok = (await readColumns()).length > 0 && ((await readClause())?.includes("'failed'") ?? false);
      if (!ok) throw e;
    }
  },
};