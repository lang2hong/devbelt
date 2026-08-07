import { Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor } from 'vscode';
import { ConnectionStore, type SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { DbTreeNode, NodeKind, type CategoryType } from './dbTreeNode';
import { l10n } from '../i18n';

/**
 * 连接树数据提供者。
 *
 * 层级（参考 Navicat）：
 *  - 根：分组 + 未分组连接
 *  - 分组：子分组 + 组内连接（支持任意层级）
 *  - 连接：数据库列表
 *  - 数据库：分类列表（表/视图/函数/事件/查询）
 *  - 分类：具体对象列表（表/视图/函数/事件/保存的查询）
 *
 * 懒加载：仅当节点被展开时才查询子节点。
 */
export class DbTreeDataProvider implements TreeDataProvider<DbTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new EventEmitter<DbTreeNode | undefined>();
  readonly onDidChangeTreeData: Event<DbTreeNode | undefined> =
    this.onDidChangeTreeDataEmitter.event;

  /** 已关闭的连接 id 集合（关闭后子节点消失，再次展开重新连接） */
  private readonly closedConns = new Set<string>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
  ) {}

  /** 刷新整棵树 */
  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  /** 标记连接已关闭（子节点将消失） */
  markClosed(connId: string): void {
    this.closedConns.add(connId);
  }

  /** 标记连接已打开（恢复可展开） */
  markOpen(connId: string): void {
    this.closedConns.delete(connId);
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
      case NodeKind.Connection:
        return this.buildConnectionChildren(element);
      case NodeKind.Database:
        return this.buildDatabaseChildren(element);
      case NodeKind.Category:
        return this.buildCategoryChildren(element);
      case NodeKind.Table:
        return this.buildColumnChildren(element);
      default:
        return [];
    }
  }

  /** 连接节点子节点：数据库列表 */
  private async buildConnectionChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
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

  /** 数据库节点子节点：5 个分类（表/视图/函数/事件/查询） */
  private buildDatabaseChildren(element: DbTreeNode): DbTreeNode[] {
    const categories: { type: CategoryType; label: string }[] = [
      { type: 'table', label: l10n('cat.tables') },
      { type: 'view', label: l10n('cat.views') },
      { type: 'function', label: l10n('cat.functions') },
      { type: 'event', label: l10n('cat.events') },
      { type: 'query', label: l10n('cat.queries') },
    ];
    return categories.map(
      (c) =>
        new DbTreeNode(
          c.label,
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Category,
          element.conn,
          undefined,
          element,
          c.type,
          element.label,
        ),
    );
  }

  /** 分类节点子节点：根据分类类型查询具体对象 */
  private async buildCategoryChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
    const db = element.database!;
    const conn = element.conn!;
    const catType = element.categoryType!;

    if (catType === 'query') {
      const queries = this.store.getQueries(conn.id, db);
      return queries.map(
        (q) =>
          new DbTreeNode(
            q.name,
            TreeItemCollapsibleState.None,
            NodeKind.SavedQuery,
            conn,
            undefined,
            element,
            undefined,
            db,
          ),
      );
    }

    const session = await this.manager.connect(conn);
    const items: DbTreeNode[] = [];

    switch (catType) {
      case 'table': {
        const tables = await session.metadata.getTables(db);
        for (const t of tables) {
          const node = new DbTreeNode(
            t.name,
            TreeItemCollapsibleState.Collapsed,
            NodeKind.Table,
            conn,
            undefined,
            element,
            undefined,
            db,
          );
          // 显示行数（MySQL 从 information_schema 直接返回）
          if (t.table_rows !== undefined) {
            node.description = String(t.table_rows) + ' rows';
          } else if (t.comment) {
            node.description = t.comment;
          }
          node.command = { command: 'dbclient.previewTable', title: 'Preview', arguments: [node] };
          items.push(node);
        }
        break;
      }
      case 'view': {
        const views = await session.metadata.getViews(db);
        for (const v of views) {
          const node = new DbTreeNode(
            v.name,
            TreeItemCollapsibleState.None,
            NodeKind.View,
            conn,
            undefined,
            element,
            undefined,
            db,
          );
          node.command = { command: 'dbclient.previewView', title: 'Preview', arguments: [node] };
          items.push(node);
        }
        break;
      }
      case 'function': {
        const routines = await session.metadata.getFunctions(db);
        for (const r of routines) {
          const node = new DbTreeNode(
            r.name,
            TreeItemCollapsibleState.None,
            NodeKind.Routine,
            conn,
            undefined,
            element,
            undefined,
            db,
            r.type,
          );
          node.command = { command: 'dbclient.openRoutine', title: 'Open', arguments: [node] };
          items.push(node);
        }
        break;
      }
      case 'event': {
        const events = await session.metadata.getEvents(db);
        for (const e of events) {
          const node = new DbTreeNode(
            e.name,
            TreeItemCollapsibleState.None,
            NodeKind.Event,
            conn,
            undefined,
            element,
            undefined,
            db,
          );
          node.command = { command: 'dbclient.openEvent', title: 'Open', arguments: [node] };
          items.push(node);
        }
        break;
      }
    }

    return items;
  }

  /** 表节点子节点：列列表（PK 用 key 图标） */
  private async buildColumnChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
    const session = await this.manager.connect(element.conn!);
    const columns = await session.metadata.getColumns(element.label, element.database);
    return columns.map((col) => {
      const node = new DbTreeNode(
        col.name,
        TreeItemCollapsibleState.None,
        NodeKind.Column,
        element.conn,
        undefined,
        element,
        undefined,
        element.database,
      );
      node.description = `${col.simpleType || col.type}`;
      if (col.isPrimary) {
        node.iconPath = new ThemeIcon('key', new ThemeColor('charts.yellow'));
        node.description = `${col.simpleType || col.type}  PK`;
      }
      if (col.nullable === 'NO' || col.isNotNull) {
        node.description += '  NOT NULL';
      }
      return node;
    });
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
    const cNodes = ungrouped.map((c) => this.makeConnectionNode(c));
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
    const cNodes = conns.map((c) => this.makeConnectionNode(c));
    return [...gNodes, ...cNodes];
  }

  /** 创建连接节点：关闭时不可展开（无箭头），双击触发重连 */
  private makeConnectionNode(conn: SavedConnection, parent?: DbTreeNode): DbTreeNode {
    const isClosed = this.closedConns.has(conn.id);
    const node = new DbTreeNode(
      conn.name || conn.host,
      isClosed ? TreeItemCollapsibleState.None : TreeItemCollapsibleState.Collapsed,
      NodeKind.Connection,
      conn,
      undefined,
      parent,
    );
    if (isClosed) {
      node.command = {
        command: 'dbclient.openConnection',
        title: 'Open',
        arguments: [conn],
      };
    }
    return node;
  }
}
