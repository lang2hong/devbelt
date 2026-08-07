import { Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { ConnectionStore } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { DbTreeNode, NodeKind } from './dbTreeNode';

/**
 * 连接树数据提供者。
 *
 * 层级：
 *  - 根：分组 + 未分组连接
 *  - 分组：子分组 + 组内连接（支持任意层级）
 *  - 连接：数据库列表（通过 db-core 元数据服务实时查询）
 *  - 数据库：表列表
 *
 * 懒加载：仅当节点被展开时才查询子节点。
 */
export class DbTreeDataProvider implements TreeDataProvider<DbTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new EventEmitter<DbTreeNode | undefined>();
  readonly onDidChangeTreeData: Event<DbTreeNode | undefined> =
    this.onDidChangeTreeDataEmitter.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
  ) {}

  /** 刷新整棵树 */
  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: DbTreeNode): TreeItem {
    return element;
  }

  async getChildren(element?: DbTreeNode): Promise<DbTreeNode[]> {
    if (!element) {
      return this.buildRootChildren();
    }

    switch (element.kind) {
      case NodeKind.Group:
        return this.buildGroupChildren(element.groupId!);
      case NodeKind.Connection: {
        const session = await this.manager.connect(element.conn!);
        const dbs = await session.metadata.getDatabases();
        return dbs.map(
          (db) =>
            new DbTreeNode(
              db,
              TreeItemCollapsibleState.Collapsed,
              NodeKind.Database,
              element.conn,
              undefined,
              element,
            ),
        );
      }
      case NodeKind.Database: {
        const session = await this.manager.connect(element.conn!);
        const tables = await session.metadata.getTables(element.label);
        return tables.map(
          (t) =>
            new DbTreeNode(
              t.name,
              TreeItemCollapsibleState.None,
              NodeKind.Table,
              element.conn,
              undefined,
              element,
            ),
        );
      }
      default:
        return [];
    }
  }

  /** 根节点：顶层分组 + 未分组连接 */
  private buildRootChildren(): DbTreeNode[] {
    const data = this.store.getTreeData();
    const topGroups = data.groups.filter((g) => !g.parentId);
    const ungrouped = data.connections.filter((c) => !c.groupId);
    const gNodes = topGroups.map(
      (g) =>
        new DbTreeNode(
          g.name,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Group,
          undefined,
          g.id,
        ),
    );
    const cNodes = ungrouped.map(
      (c) =>
        new DbTreeNode(
          c.name || c.host,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Connection,
          c,
        ),
    );
    return [...gNodes, ...cNodes];
  }

  /** 分组节点：子分组 + 组内连接 */
  private buildGroupChildren(groupId: string): DbTreeNode[] {
    const data = this.store.getTreeData();
    const childGroups = data.groups.filter((g) => g.parentId === groupId);
    const conns = data.connections.filter((c) => c.groupId === groupId);
    const gNodes = childGroups.map(
      (g) =>
        new DbTreeNode(
          g.name,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Group,
          undefined,
          g.id,
        ),
    );
    const cNodes = conns.map(
      (c) =>
        new DbTreeNode(
          c.name || c.host,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Connection,
          c,
        ),
    );
    return [...gNodes, ...cNodes];
  }
}