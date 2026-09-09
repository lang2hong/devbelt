import type { Migration } from '../migrate.js';

/**
 * 幂等回执响应体扩容（P3 切片 4 审计导出）。
 *
 * 审计导出单次可达 10,000 行、audit_events.reason 单行可达 500 字符，全中文原因即可逼近
 * 15 MiB；加 JSON/CSV 字段与转义后可能超过 MEDIUMTEXT(16 MiB) 上限，导致回执 complete 失败。
 * 回执响应体扩为 LONGTEXT（4 GiB），确保合法 10,000 行导出可完整落回执。
 */
export const idempotencyReceiptLongtextMigration: Migration = {
  version: '016_idempotency_receipt_longtext',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`ALTER TABLE idempotency_receipts MODIFY response_body LONGTEXT NULL`);
  },
};