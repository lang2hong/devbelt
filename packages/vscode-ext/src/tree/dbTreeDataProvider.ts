import { Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor, window } from 'vscode';
import { DatabaseType } from '@db-client/core';
import { ConnectionStore, type SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { DbTreeNode, NodeKind, type CategoryType } from './dbTreeNode';
import { MetadataNodeBuilder } from './metadataNodeBuilder';
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

  /** 已打开的连接 id 集合（默认全部未打开，需右键"打开连接"） */
  private readonly openConns = new Set<string>();

  /** 已打开连接的服务器类型+版本摘要（连接名右侧 description） */
  private readonly connVersions = new Map<string, string>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
  ) {}

  /** 刷新整棵树 */
  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  /** 刷新单个节点（重新拉取其子节点） */
  refreshNode(node: DbTreeNode): void {
    this.onDidChangeTreeDataEmitter.fire(node);
  }

  /** 标记连接已打开（可展开） */
  markOpen(connId: string): void {
    this.openConns.add(connId);
  }

  /** 设置连接的服务器摘要（类型+版本），显示在连接名右侧 */
  setConnVersion(connId: string, desc: string): void {
    this.connVersions.set(connId, desc);
  }

  /** 标记连接已关闭（不可展开） */
  markClosed(connId: string): void {
    this.openConns.delete(connId);
    this.connVersions.delete(connId);
  }

  getTreeItem(element: DbTreeNode): TreeItem {
    return element;
  }

  async getChildren(element?: DbTreeNode): Promise<DbTreeNode[]> {
    if (!element) {
      return this.buildRootChildren();
    }

    try {
      switch (element.kind) {
        case NodeKind.Group:
          return this.buildGroupChildren(element.groupId!);
        case NodeKind.Connection:
          return this.buildConnectionChildren(element);
        case NodeKind.Database:
          return this.buildDatabaseChildren(element);
        case NodeKind.Category:
          return this.buildCategoryChildren(element);
        case NodeKind.QueryFolder:
          return this.buildQueryFolderChildren(element);
        case NodeKind.Table:
          return this.buildColumnChildren(element);
        default:
          return [];
      }
    } catch (error) {
      window.showErrorMessage(
        l10n('tree.loadFailed', { label: element.label, message: (error as Error).message }),
      );
      return [];
    }
  }

  /** 连接节点子节点：数据库列表 */
  private async buildConnectionChildren(element: DbTreeNode): Promise<DbTreeNode[]> {
    const session = await this.manager.connect(element.conn!);
    if (!session.capabilities.multiDatabaseExplorer) {
      return [
        new DbTreeNode(
          element.conn!.database || (element.conn!.dbType === DatabaseType.PG ? 'public' : 'main'),
          TreeItemCollapsibleState.Collapsed,
          NodeKind.Database,
          element.conn,
          undefined,
          element,
        ),
      ];
    }
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
      { type: 'user', label: l10n('cat.users') },
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
      const folderNodes = this.store.getQueryFolders().map(
        (folder) =>
          new DbTreeNode(
            folder.name,
            TreeItemCollapsibleState.Collapsed,
            NodeKind.QueryFolder,
            conn,
            undefined,
            element,
            undefined,
            db,
            undefined,
            undefined,
            folder.id,
          ),
      );
      const queryNodes = this.store.getQueriesInFolder(conn.id, db).map(
        (q) => {
          const n = new DbTreeNode(
            q.name,
            TreeItemCollapsibleState.None,
            NodeKind.SavedQuery,
            conn,
            undefined,
            element,
            undefined,
            db,
            undefined,
            q.id,
          );
          n.command = { command: 'dbclient.openQuery', title: 'Open', arguments: [n] };
          return n;
        },
      );
      return [...folderNodes, ...queryNodes];
    }

    const session = await this.manager.connect(conn);
    const builder = new MetadataNodeBuilder(session.metadata);

    switch (catType) {
      case 'table':
      case 'view':
      case 'function':
      case 'event':
      case 'user':
        return builder.build(catType, conn, db, element);
      default:
        return [];
    }
  }

  /** 查询文件夹子节点：文件夹内保存的查询 */
  private buildQueryFolderChildren(element: DbTreeNode): DbTreeNode[] {
    const conn = element.conn!;
    const db = element.database;
    return this.store.getQueriesInFolder(conn.id, db, element.queryFolderId).map(
      (q) => {
        const n = new DbTreeNode(
          q.name,
          TreeItemCollapsibleState.None,
          NodeKind.SavedQuery,
          conn,
          undefined,
          element,
          undefined,
          db,
          undefined,
          q.id,
        );
        n.command = { command: 'dbclient.openQuery', title: 'Open', arguments: [n] };
        return n;
      },
    );
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
    const cNodes = ungrouped.map((c) => this.makeConnectionNode(this.withCredentials(c)));
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
    const cNodes = conns.map((c) => this.makeConnectionNode(this.withCredentials(c)));
    return [...gNodes, ...cNodes];
  }

  /** 用 store 中 materialize 的连接替换原始（无凭据）连接，确保树节点携带密码。 */
  private withCredentials(conn: SavedConnection): SavedConnection {
    return this.store.get(conn.id) || conn;
  }

  /** 创建连接节点：未打开时无箭头+双击触发打开；已打开时可展开 */
  private makeConnectionNode(conn: SavedConnection, parent?: DbTreeNode): DbTreeNode {
    const isOpen = this.openConns.has(conn.id);
    const node = new DbTreeNode(
      conn.name || conn.host,
      isOpen ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
      NodeKind.Connection,
      conn,
      undefined,
      parent,
    );
    if (!isOpen) {
      node.id = `closed_${conn.id}`;
      node.command = {
        command: 'dbclient.openConnection',
        title: 'Open',
        arguments: [conn],
      };
    } else {
      node.id = conn.id;
      node.description = this.connVersions.get(conn.id) || '';
      node.iconPath = new ThemeIcon('server', new ThemeColor('gitDecoration.untrackedResourceForeground'));
    }
    return node;
  }
}
