/**
 * 本地记录的唯一 id 生成。
 *
 * 单纯用 `Date.now()` 会碰撞：同一毫秒内连续创建（批量导入、循环建文件夹、
 * 快速连点）会拿到完全相同的 id。实测连续 5 次 `q-${Date.now()}` 只产出
 * 1 个唯一值。碰撞后按 id 覆盖的写入（memento、同步合并 mergeById）会丢记录。
 *
 * 这里在毫秒时间戳后追加进程内单调计数器：时间戳保留可排序性与可读性，
 * 计数器消除同毫秒碰撞。计数器随扩展进程重启归零，但时间戳已经前进，
 * 因此跨进程也不会撞。
 */
let counter = 0;

/**
 * 生成带前缀的唯一 id，形如 `q-1786676273091-3`。
 * @param prefix 业务前缀（如 `q` 查询、`qf` 查询文件夹、`g` 分组）
 */
export function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++counter}`;
}
