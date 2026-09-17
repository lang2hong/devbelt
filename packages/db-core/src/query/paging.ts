import type { SqlDialect } from '../dialect/sqlDialect.js';

/** keyset 分页所需的最小查询源（结构类型，避免耦合具体服务）。 */
export interface KeysetQuerySource {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

/**
 * keyset（深分页）行流：唯一实现「keyset vs OFFSET 分支 + after 推进 + 终止条件 + 取消」。
 *
 * 有 `orderColumns` 时用 `dialect.getKeysetSql`（不随页数线性变慢），否则回退
 * `dialect.getPagedSql`（OFFSET）。`baseSql` 必须是「列选择 + FROM（可含 JOIN）」的
 * 基本 SELECT，不得自带 ORDER BY / LIMIT（本函数与方言会追加）。
 *
 * 逐页 yield `rows`，由调用方决定如何消费（落盘 / 建映射 / 写块），避免四处重复
 * 同一控制流而各自静默发散（S1 的 MySQL 复合主键问题正是这类重复的代价）。
 *
 * @param orderColumns 未包裹的排序列名（通常主键）；空数组表示退化为 OFFSET。
 * @param opts.cancelError 取消时抛出的错误构造器（调用方各自区分取消类型）。
 */
export async function* streamRowsByKeyset(
  source: KeysetQuerySource,
  dialect: SqlDialect,
  baseSql: string,
  orderColumns: string[],
  pageSize: number,
  opts?: { isCancelled?: () => boolean; cancelError?: () => Error },
): AsyncGenerator<Record<string, unknown>[]> {
  let offset = 0;
  let after: unknown[] | undefined;
  for (;;) {
    if (opts?.isCancelled?.()) throw (opts.cancelError?.() ?? new Error('Operation cancelled'));
    const sql = orderColumns.length > 0
      ? dialect.getKeysetSql(baseSql, orderColumns, after, pageSize)
      : dialect.getPagedSql(baseSql, offset, pageSize);
    const result = await source.query(sql);
    const rows = result.rows as Record<string, unknown>[];
    yield rows;
    if (rows.length < pageSize) break;
    if (orderColumns.length > 0) {
      const lastRow = rows[rows.length - 1];
      after = orderColumns.map((c) => lastRow[c]);
    } else {
      offset += pageSize;
    }
  }
}