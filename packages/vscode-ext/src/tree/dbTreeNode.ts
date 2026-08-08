import { TreeItem, TreeItemCollapsibleState, ThemeIcon } from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';

/** 树节点类型枚举 */
export enum NodeKind {
  Group = 'group',
  Connection = 'connection',
  Database = 'database',
  Category = 'category',
  Table = 'table',
  View = 'view',
  Routine = 'routine',
  Event = 'event',
  SavedQuery = 'savedQuery',
  Column = 'column',
  User = 'user',
}

/** 分类子类型 */
export type CategoryType = 'table' | 'view' | 'function' | 'event' | 'query' | 'user';

/** 各节点类型的 ThemeIcon id（参考 database-client 图标体系） */
const ICON_MAP: Record<string, string> = {
  [NodeKind.Group]: 'folder',
  [NodeKind.Connection]: 'server',
  [NodeKind.Database]: 'database',
  [NodeKind.Table]: 'split-horizontal',
  [NodeKind.View]: 'menu',
  [NodeKind.Routine]: 'symbol-function',
  [NodeKind.Event]: 'zap',
  [NodeKind.SavedQuery]: 'code',
  [NodeKind.Column]: 'symbol-field',
  [NodeKind.User]: 'person',
};

/** 分类节点的图标 id（按 categoryType 区分） */
const CATEGORY_ICON: Record<CategoryType, string> = {
  table: 'list-flat',
  view: 'menu',
  function: 'symbol-function',
  event: 'zap',
  query: 'code',
  user: 'account',
};

/**
 * 连接树节点。
 * 轻量模型：
 *  - Group：分组节点（携带分组 id）
 *  - Connection：连接节点（携带配置）
 *  - Database：数据库节点
 *  - Category：分类节点（表/视图/函数/事件/查询）
 *  - Table/View/Routine/Event/SavedQuery/Column：元数据展示节点
 */
export class DbTreeNode extends TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsible: TreeItemCollapsibleState,
    public readonly kind: NodeKind,
    public readonly conn?: SavedConnection,
    public readonly groupId?: string,
    public readonly parent?: DbTreeNode,
    /** 分类子类型（仅 Category 节点） */
    public readonly categoryType?: CategoryType,
    /** 所属数据库名（Category/Table/View/Routine/Event 节点携带） */
    public readonly database?: string,
    /** 函数/存储过程类型（仅 Routine 节点：FUNCTION/PROCEDURE） */
    public readonly routineType?: string,
  ) {
    super(label, collapsible);
    if (kind === NodeKind.Connection) {
      this.contextValue = collapsible === TreeItemCollapsibleState.None
        ? 'connectionClosed'
        : 'connectionOpen';
    } else if (kind === NodeKind.Category && categoryType) {
      this.contextValue = `${kind}_${categoryType}`;
    } else {
      this.contextValue = kind;
    }
    // 图标：Category 按 categoryType 选，其余按 kind 选
    const iconId = kind === NodeKind.Category && categoryType
      ? CATEGORY_ICON[categoryType]
      : ICON_MAP[kind];
    if (iconId) {
      this.iconPath = new ThemeIcon(iconId);
    }
  }
}
