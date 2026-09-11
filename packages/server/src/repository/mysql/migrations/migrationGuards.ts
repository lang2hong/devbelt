/**
 * 迁移共享守卫：执行 DDL，仅在「对象已存在」错误码下才吞错，且吞错后回验
 * information_schema 确认目标约束/索引确实存在；否则上抛，禁止 runner 写账本。
 */

export async function addOrVerify(
  db: { query(sql: string, params?: any[]): Promise<any> },
  ddl: string,
  verifySql: string,
): Promise<void> {
  try {
    await db.query(ddl);
  } catch (e) {
    if (!isDuplicateObject(e)) throw e;
    const [rows] = (await db.query(verifySql)) as [Array<unknown>, unknown];
    if (!rows.length) throw e;
  }
}

export function isDuplicateObject(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    ((err as { code?: string }).code === 'ER_DUP_KEYNAME' ||
      (err as { errno?: number }).errno === 1061 ||
      (err as { code?: string }).code === 'ER_DUP_CONSTRAINT' ||
      (err as { errno?: number }).errno === 3822)
  );
}