/**
 * 表列布局：将持久化的列布局（隐藏列/列序/列宽）与当前字段集求交集。
 *
 * 纯函数，无 vscode 依赖，供 tableQueryView 与单测复用。
 * 目的：当前表结构变化（增删列）后，布局只保留仍存在的列，避免脏数据。
 */

export interface TableLayout {
  hiddenColumns: string[];
  columnOrder: string[];
  columnWidths: Record<string, number>;
}

/** 隐藏列：仅保留仍存在于当前字段集的列。 */
export function reconcileHiddenColumns(hidden: string[], knownFields: string[]): string[] {
  if (!knownFields.length) return hidden;
  const known = new Set(knownFields);
  return hidden.filter((c) => known.has(c));
}

/** 列顺序：保留已保存顺序中仍存在的列，再追加当前字段集中未排序的列。 */
export function reconcileColumnOrder(order: string[], knownFields: string[]): string[] {
  if (!knownFields.length) return order;
  const known = new Set(knownFields);
  const ordered = order.filter((column) => known.has(column));
  const remaining = knownFields.filter((column) => !ordered.includes(column));
  return [...ordered, ...remaining];
}

/** 列宽：仅保留仍存在于当前字段集的列宽。 */
export function reconcileColumnWidths(widths: Record<string, number>, knownFields: string[]): Record<string, number> {
  if (!knownFields.length) return widths;
  const known = new Set(knownFields);
  return Object.fromEntries(Object.entries(widths).filter(([column]) => known.has(column)));
}

/** 一次求交集整个布局。 */
export function reconcileLayout(saved: TableLayout, knownFields: string[]): TableLayout {
  return {
    hiddenColumns: reconcileHiddenColumns(saved.hiddenColumns, knownFields),
    columnOrder: reconcileColumnOrder(saved.columnOrder, knownFields),
    columnWidths: reconcileColumnWidths(saved.columnWidths, knownFields),
  };
}