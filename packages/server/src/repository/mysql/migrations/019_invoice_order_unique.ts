import type { Migration } from '../migrate.js';

/**
 * 发票「一订单一票」约束（P4 切片 3 复审 P1）。
 *
 * 幂等只有同 key 防意外重复提交；不同 Idempotency-Key / 会话 / 用户主动重试会再次
 * 全额开票，属税务合规事故。本迁移给 invoices.order_id 加唯一键，把「一笔订单最多
 * 一个发票申请」提升为数据库不变量。
 *
 * MySQL 普通 UNIQUE 索引允许多个 NULL，故 `order_id IS NULL` 的未来人工记录（无订单）
 * 不受影响，只为**有订单归属**的申请去重。
 */
export const invoiceOrderUniqueMigration: Migration = {
  version: '019_invoice_order_unique',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    if (await hasExactUniqueIndex(db)) return;

    try {
      await db.query(`CREATE UNIQUE INDEX uq_invoices_order ON invoices (order_id)`);
    } catch (e) {
      // 仅「索引名已存在」可吞（幂等重跑的竞态）；其余错误（重复 order_id 数据
      // ER_DUP_ENTRY、表不存在、权限不足、锁超时、SQL 错误）一律上抛，禁止写账本。
      if (isDuplicateIndexName(e)) {
        // 竞态：另一实例刚建好。复核其确为 invoices(order_id) 单列唯一索引，否则仍判失败。
        if (await hasExactUniqueIndex(db)) return;
      }
      throw e;
    }
  },
};

/**
 * 严格校验 `uq_invoices_order` 是**且仅是** invoices(order_id) 的单列唯一索引：
 * - 索引名为 uq_invoices_order、NON_UNIQUE=0
 * - 仅一列，且该列为 order_id，SEQ_IN_INDEX=1
 * 用聚合而非单行命中，避免同名但列定义错误（如 (user_id,email) 复合唯一）被误判为成功。
 */
async function hasExactUniqueIndex(db: {
  query(sql: string): Promise<unknown>;
}): Promise<boolean> {
  const [rows] = (await db.query(
    `SELECT COUNT(*) AS column_count,
            MIN(COLUMN_NAME) AS only_column,
            MIN(SEQ_IN_INDEX) AS first_position,
            MAX(SEQ_IN_INDEX) AS last_position
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices'
       AND INDEX_NAME = 'uq_invoices_order' AND NON_UNIQUE = 0`,
  )) as [Array<{ column_count: number; only_column: string | null; first_position: number | null; last_position: number | null }>, unknown];

  const r = rows[0];
  if (!r) return false;
  return (
    Number(r.column_count) === 1 &&
    r.only_column === 'order_id' &&
    Number(r.first_position) === 1 &&
    Number(r.last_position) === 1
  );
}

function isDuplicateIndexName(e: unknown): boolean {
  return (
    !!e &&
    typeof e === 'object' &&
    ((e as { code?: string }).code === 'ER_DUP_KEYNAME' ||
      (e as { errno?: number }).errno === 1061)
  );
}