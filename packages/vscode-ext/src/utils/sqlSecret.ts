/**
 * 含密码/密钥的 SQL 特征（单一来源）。
 *
 * 这类 SQL 一旦进历史/审计就会被持久化到 globalState 并参与云同步，
 * 明文密码会离开本机。db-core 的用户管理方法已带 `skipHistory`，这里是第二道
 * 防线；历史记录器与查询执行器必须共用同一份规则，避免任一路径漏网。
 */
export const SECRET_SQL = /\b(IDENTIFIED\s+(BY|WITH)|PASSWORD\s*=?\s*'|WITH\s+(LOGIN\s+)?PASSWORD)/i;

/** 语句是否可能包含明文口令。 */
export function containsSecretSql(sql: string): boolean {
  return SECRET_SQL.test(sql);
}
