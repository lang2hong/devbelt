import { TreeItemCollapsibleState } from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';
import { DbTreeNode, NodeKind, type CategoryType } from './dbTreeNode';

/**
 * 元数据 → 树节点映射器。
 *
 * 把数据库对象的元数据（表/视图/函数/事件/用户）转换为树节点，
 * 与树的结构（根/分组/连接/数据库）解耦，便于独立测试。
 */
export interface MetadataSource {
  getTables(db: string): Promise<{ name: string; table_rows?: string; comment?: string }[]>;
  getViews(db: string): Promise<{ name: string }[]>;
  getFunctions(db: string): Promise<{ name: string; type?: string }[]>;
  getEvents(db: string): Promise<{ name: string }[]>;
  getUsers(): Promise<{ name: string; host?: string }[]>;
  getColumns(table: string, database?: string): Promise<{
    name: string;
    type?: string;
    simpleType?: string;
    isPrimary?: boolean;
    nullable?: string;
    isNotNull?: boolean;
  }[]>;
}

export class MetadataNodeBuilder {
  constructor(private readonly metadata: MetadataSource) {}

  /** 按分类类型构建对象节点列表。 */
  async build(categoryType: CategoryType, conn: SavedConnection, database: string, parent: DbTreeNode): Promise<DbTreeNode[]> {
    switch (categoryType) {
      case 'table': return this.buildTables(conn, database, parent);
      case 'view': return this.buildViews(conn, database, parent);
      case 'function': return this.buildFunctions(conn, database, parent);
      case 'event': return this.buildEvents(conn, database, parent);
      case 'user': return this.buildUsers(conn, database, parent);
      default: return [];
    }
  }

  private async buildTables(conn: SavedConnection, database: string, parent: DbTreeNode): Promise<DbTreeNode[]> {
    const tables = await this.metadata.getTables(database);
    return tables.map((t) => {
      const node = new DbTreeNode(
        t.name,
        TreeItemCollapsibleState.Collapsed,
        NodeKind.Table,
        conn,
        undefined,
        parent,
        undefined,
        database,
      );
      if (t.table_rows !== undefined) {
        node.description = String(t.table_rows) + ' rows';
      } else if (t.comment) {
        node.description = t.comment;
      }
      node.command = { command: 'dbclient.previewTable', title: 'Preview', arguments: [node] };
      return node;
    });
  }

  private async buildViews(conn: SavedConnection, database: string, parent: DbTreeNode): Promise<DbTreeNode[]> {
    const views = await this.metadata.getViews(database);
    return views.map((v) => {
      const node = new DbTreeNode(
        v.name,
        TreeItemCollapsibleState.None,
        NodeKind.View,
        conn,
        undefined,
        parent,
        undefined,
        database,
      );
      node.command = { command: 'dbclient.previewView', title: 'Preview', arguments: [node] };
      return node;
    });
  }

  private async buildFunctions(conn: SavedConnection, database: string, parent: DbTreeNode): Promise<DbTreeNode[]> {
    const routines = await this.metadata.getFunctions(database);
    return routines.map((r) => {
      const node = new DbTreeNode(
        r.name,
        TreeItemCollapsibleState.None,
        NodeKind.Routine,
        conn,
        undefined,
        parent,
        undefined,
        database,
        r.type,
      );
      node.command = { command: 'dbclient.openRoutine', title: 'Open', arguments: [node] };
      return node;
    });
  }

  private async buildEvents(conn: SavedConnection, database: string, parent: DbTreeNode): Promise<DbTreeNode[]> {
    const events = await this.metadata.getEvents(database);
    return events.map((e) => {
      const node = new DbTreeNode(
        e.name,
        TreeItemCollapsibleState.None,
        NodeKind.Event,
        conn,
        undefined,
        parent,
        undefined,
        database,
      );
      node.command = { command: 'dbclient.openEvent', title: 'Open', arguments: [node] };
      return node;
    });
  }

  private async buildUsers(conn: SavedConnection, database: string, parent: DbTreeNode): Promise<DbTreeNode[]> {
    const users = await this.metadata.getUsers();
    return users.map((u) => {
      const node = new DbTreeNode(
        u.host ? `${u.name}@${u.host}` : u.name,
        TreeItemCollapsibleState.None,
        NodeKind.User,
        conn,
        undefined,
        parent,
        undefined,
        database,
      );
      return node;
    });
  }
}