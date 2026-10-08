/**
 * 事务控制语句识别（导入/恢复时用于**剥离** dump 自带的事务控制，避免提前 COMMIT 外层事务）。
 *
 * 覆盖常见变体（含 MySQL/PG）：
 *  - `BEGIN` / `BEGIN WORK` / `BEGIN TRANSACTION` / `BEGIN ISOLATION LEVEL ...`
 *  - `START TRANSACTION [READ WRITE|READ ONLY]`
 *  - `COMMIT` / `COMMIT WORK` / `COMMIT TRANSACTION` / `COMMIT AND [NO] CHAIN`
 *  - `END` / `END WORK` / `END TRANSACTION`
 *  - `ROLLBACK` / `ROLLBACK WORK` / `ROLLBACK AND [NO] CHAIN`
 *  - `ABORT` / `ABORT WORK` / `ABORT TRANSACTION`
 *
 * 只匹配**整条**语句（事务控制不允许再跟别的语句）；调用方传入 `stmt.trim()`。
 */
export const TX_CONTROL_SQL =
  /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b(?:[\s,=]*[A-Za-z_]+)*\s*;?\s*$/i;

/** 是否为纯事务控制语句（可剥离）。 */
export function isTxControlStatement(stmt: string): boolean {
  return TX_CONTROL_SQL.test(stmt.trim());
}