import { TreeItem, TreeItemCollapsibleState } from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';

/** 树节点类型枚举 */
export enum NodeKind {
  Group = 'group',
  Connection = 'connection',
  Database = 'database',
  Table = 'table',
  Column = 'column',
}

/**
 * 连接树节点。
 * 轻量模型：
 *  - Group：分组节点（携带分组 id）
 *  - Connection：连接节点（携带配置）
 *  - Database/Table/Column：元数据展示节点
 */
export class DbTreeNode extends TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsible: TreeItemCollapsibleState,
    public readonly kind: NodeKind,
    public readonly conn?: SavedConnection,
    public readonly groupId?: string,
    public readonly parent?: DbTreeNode,
  ) {
    super(label, collapsible);
    this.contextValue = kind;
    this.iconPath = undefined;
  }
}