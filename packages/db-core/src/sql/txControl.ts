/**
 * 事务控制语句识别（导入/恢复时用于**剥离** dump 自带的事务控制，避免提前 COMMIT 外层事务）。
 *
 * 覆盖常见变体（含 MySQL/PG）：
 *  - `BEGIN` / `BEGIN WORK` / `BEGIN TRANSACTION` / `BEGIN ISOLATION LEVEL ...` / `BEGIN READ WRITE`
 *  - `START TRANSACTION [READ WRITE|READ ONLY|ISOLATION LEVEL ...]`
 *  - `COMMIT` / `COMMIT WORK` / `COMMIT TRANSACTION` / `COMMIT AND [NO] CHAIN`
 *  - `END` / `END WORK` / `END TRANSACTION`
 *  - `ROLLBACK` / `ROLLBACK WORK` / `ROLLBACK AND [NO] CHAIN`
 *  - `ABORT` / `ABORT WORK` / `ABORT TRANSACTION`
 *
 * 只匹配**整条**语句（事务控制不允许再跟别的语句）；调用方传入 `stmt.trim()`。
 * 有意**不**匹配：`ROLLBACK TO [SAVEPOINT] <name>`、`END IF/LOOP/CASE/WHILE`、
 * `COMMIT/ROLLBACK PREPARED <gid>` —— 这些是真实语句，剥离会改变恢复语义。
 */
// 起事务的可选修饰子句：允许逗号分隔（`ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE`）
// 与 `WITH CONSISTENT SNAPSHOT`（MySQL）。
const TX_OPEN_MODIFIERS =
  '(?:\\s*,?\\s*(?:READ\\s+WRITE|READ\\s+ONLY|ISOLATION\\s+LEVEL\\s+[A-Za-z][A-Za-z ]*|DEFERRABLE|NOT\\s+DEFERRABLE|WITH\\s+CONSISTENT\\s+SNAPSHOT))*';

const VARIANTS = [
  `BEGIN(?:\\s+(?:WORK|TRANSACTION))?${TX_OPEN_MODIFIERS}`,
  `START\\s+TRANSACTION${TX_OPEN_MODIFIERS}`,
  '(?:COMMIT|END)(?:\\s+(?:WORK|TRANSACTION))?(?:\\s+AND\\s+(?:NO\\s+)?CHAIN)?',
  'ROLLBACK(?:\\s+(?:WORK|TRANSACTION))?(?:\\s+AND\\s+(?:NO\\s+)?CHAIN)?',
  'ABORT(?:\\s+(?:WORK|TRANSACTION))?',
];

export const TX_CONTROL_SQL = new RegExp(`^\\s*(?:${VARIANTS.join('|')})\\s*;?\\s*$`, 'i');

/** 是否为纯事务控制语句（可剥离）。 */
export function isTxControlStatement(stmt: string): boolean {
  return TX_CONTROL_SQL.test(stmt.trim());
}
