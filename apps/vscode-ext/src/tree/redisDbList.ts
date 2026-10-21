/**
 * Redis DB 列表合并（D11「DB 列表来源」）。
 *
 * 树的 DB 候选 = `CONFIG GET databases`（若可用，列出含空库的全部逻辑库）
 * ∪ `INFO keyspace`（有键的库）∪ 连接默认库（保证默认空库可达、可搜索/新建键）。
 * 纯函数：排序、去重、忽略非法索引，便于单测。
 */
/** 树中实际展示的 DB：仅 keyspace 有键的库；整个实例为空时保留默认库以便新建键。 */
export function visibleRedisDbIndexes(keyspaceIndices: readonly number[], defaultDb: number): number[] {
  const out = new Set<number>();
  for (const i of keyspaceIndices) {
    if (Number.isInteger(i) && i >= 0) out.add(i);
  }
  if (out.size === 0 && Number.isInteger(defaultDb) && defaultDb >= 0) out.add(defaultDb);
  return [...out].sort((a, b) => a - b);
}

export function mergeRedisDbIndexes(
  keyspaceIndices: readonly number[],
  dbCount: number | null,
  defaultDb: number,
): number[] {
  const out = new Set<number>();
  if (dbCount !== null && dbCount > 0) {
    for (let i = 0; i < dbCount; i++) out.add(i);
  }
  for (const i of keyspaceIndices) {
    if (Number.isInteger(i) && i >= 0) out.add(i);
  }
  if (Number.isInteger(defaultDb) && defaultDb >= 0) out.add(defaultDb);
  return [...out].sort((a, b) => a - b);
}