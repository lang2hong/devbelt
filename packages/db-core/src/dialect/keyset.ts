/**
 * keyset（seek）分页 SQL 构造，供各方言 `getKeysetSql` 复用。
 *
 * **baseSql 约束**：必须是「列选择 + FROM（可含 JOIN）」的基本 SELECT，**不得**
 * 自带 WHERE / GROUP BY / ORDER BY / LIMIT —— 本函数会追加 `WHERE … ORDER BY … LIMIT`。
 * 需要过滤时由调用方在外层包裹。
 *
 * 比较采用**展开式**而非行值构造器：
 *   `(c1 > v1) OR (c1 = v1 AND c2 > v2) OR (c1 = v1 AND c2 = v2 AND c3 > v3) …`
 * 因为 MySQL 不支持行值 `(a,b) > (v1,v2)`（仅 =/<>/IN），复合主键续页会报
 * ERROR 1241。展开式在三家方言上都成立。
 */
export function buildKeysetSql(
  baseSql: string,
  orderColumns: string[],
  afterValues: unknown[] | undefined,
  limit: number,
  wrap: (identifier: string) => string,
  escapeValue: (value: unknown) => string,
): string {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`keyset limit must be a positive integer (got ${limit})`);
  }
  if (orderColumns.length === 0) {
    throw new Error('keyset requires at least one order column');
  }
  if (afterValues && afterValues.length !== orderColumns.length) {
    throw new Error('keyset afterValues length must match orderColumns');
  }

  const cols = orderColumns.map(wrap);
  if (!afterValues) {
    return `${baseSql} ORDER BY ${cols.join(', ')} LIMIT ${limit}`;
  }

  const vals = afterValues.map(escapeValue);
  for (const v of afterValues) {
    // keyset 游标列必须是 NOT NULL 且唯一（通常主键）。NULL 参与比较恒为 UNKNOWN，
    // 会静默跳过「与游标共享该列前缀及其后序」的行 —— 宁可 fail-closed 也不丢行。
    if (v === null || v === undefined) {
      throw new Error('keyset afterValues must not contain null/undefined');
    }
  }
  const terms: string[] = [];
  for (let i = 0; i < cols.length; i++) {
    const conds: string[] = [];
    for (let j = 0; j < i; j++) conds.push(`${cols[j]} = ${vals[j]}`);
    conds.push(`${cols[i]} > ${vals[i]}`);
    terms.push(`(${conds.join(' AND ')})`);
  }
  return `${baseSql} WHERE ${terms.join(' OR ')} ORDER BY ${cols.join(', ')} LIMIT ${limit}`;
}