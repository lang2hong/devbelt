/**
 * 同步合并所需的最小记录契约：唯一 id + 软删除墓碑 + 更新时间戳。
 */
export interface SyncRecord {
  id: string;
  deleted?: boolean;
  updateTime?: number;
}

/**
 * 按 id 并集合并两份记录集合，统一规则：
 *  1. 任一侧 `deleted=true` → 结果标记为已删除（删除优先，删除可跨端传播）；
 *  2. 否则取 `updateTime` 较新者（最新更新胜），相同时间取远端；
 *  3. 仅在一侧存在的记录直接保留。
 *
 * 删除胜出时合并两侧字段并强制 `deleted=true`，便于保留墓碑元数据。
 */
export function mergeById<T extends SyncRecord>(local: T[], remote: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of local) map.set(item.id, item);
  for (const item of remote) {
    const prev = map.get(item.id);
    if (!prev) {
      map.set(item.id, item);
      continue;
    }
    if (item.deleted || prev.deleted) {
      map.set(item.id, { ...prev, ...item, deleted: true });
      continue;
    }
    const remoteTime = item.updateTime ?? 0;
    const localTime = prev.updateTime ?? 0;
    map.set(item.id, remoteTime >= localTime ? item : prev);
  }
  return [...map.values()];
}
