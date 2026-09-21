import type { ConnectionGroup } from '@devbelt/db-host/connection/connectionStore';

/**
 * 扁平化分组树（按 parentId 深度优先遍历，带缩进层级）。
 *
 * 供「移动到分组」「导出连接」等 QuickPick、以及连接表单分组下拉使用，
 * 让同名分组也能靠层级区分。
 *
 * 孤儿分组（parentId 指向不存在的组）按顶层兜底，避免被漏掉。
 */
export interface GroupEntry {
  group: ConnectionGroup;
  depth: number;
  /** 完整路径，如 "天九/数科" */
  path: string;
}

export function flattenGroups(groups: ConnectionGroup[]): GroupEntry[] {
  const ids = new Set(groups.map((g) => g.id));
  const roots = groups.filter((g) => !g.parentId || !ids.has(g.parentId));
  const byParent = new Map<string, ConnectionGroup[]>();
  for (const g of groups) {
    if (!g.parentId || !ids.has(g.parentId)) continue;
    const arr = byParent.get(g.parentId) ?? [];
    arr.push(g);
    byParent.set(g.parentId, arr);
  }
  const out: GroupEntry[] = [];
  const visit = (g: ConnectionGroup, depth: number, parentPath: string): void => {
    const path = parentPath ? `${parentPath}/${g.name}` : g.name;
    out.push({ group: g, depth, path });
    for (const child of byParent.get(g.id) ?? []) visit(child, depth + 1, path);
  };
  for (const root of roots) visit(root, 0, '');
  return out;
}