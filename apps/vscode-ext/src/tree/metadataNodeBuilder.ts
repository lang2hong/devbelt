import { TreeItemCollapsibleState } from 'vscode';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { DbTreeNode, NodeKind, type CategoryType } from './dbTreeNode';

/**
 * 元数据 → 树节点映射器。
 *
 * 把数据库对象的元数据（表/视图/函数/事件/用户）转换为树节点，
 * 与树的结构（根/分组/连接/数据库）解耦，便于独立测试。
 */
export interface MetadataSource {
  getTables(db: string): Promise<{ name: string; table_rows?: string; comment?: string; data_length?: string; index_length?: string; auto_increment?: string }[]>;
  getViews(db: string): Promise<{ name: string }[]>;
  getFunctions(db: string): Promise<{ name: string; type?: string }[]>;
  getEvents(db: string): Promise<{ name: string }[]>;
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

  /**
   * 稳定节点 id：父节点 id（分类节点）作基，退化为连接+库；确保整树 refresh 后展开态不丢。
   * 同层按 `kind:name` 唯一（routine 名称在不同类型下可能重名，故带 kind）。
   */
  private idFor(parent: DbTreeNode, conn: SavedConnection, database: string, kind: string, name: string): string {
    const base = parent.id || `${conn.id}:sqldb:${database}`;
    return `${base}:${kind}:${name}`;
  }

  /** 按分类类型构建对象节点列表。 */
  async build(categoryType: CategoryType, conn: SavedConnection, database: string, parent: DbTreeNode): Promise<DbTreeNode[]> {
    switch (categoryType) {
      case 'table': return this.buildTables(conn, database, parent);
      case 'view': return this.buildViews(conn, database, parent);
      case 'function': return this.buildFunctions(conn, database, parent);
      case 'event': return this.buildEvents(conn, database, parent);
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
      const rows = t.table_rows !== undefined ? String(t.table_rows) + ' rows' : '';
      if (rows) {
        node.description = rows;
      } else if (t.comment) {
        node.description = t.comment;
      }
      node.id = this.idFor(parent, conn, database, 'tbl', t.name);
      node.tooltip = formatTableTooltip(t);
      node.command = { command: 'devbelt.previewTable', title: 'Preview', arguments: [node] };
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
      node.id = this.idFor(parent, conn, database, 'view', v.name);
      node.command = { command: 'devbelt.previewView', title: 'Preview', arguments: [node] };
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
      node.id = this.idFor(parent, conn, database, r.type === 'PROCEDURE' ? 'proc' : 'fn', r.name);
      node.command = { command: 'devbelt.openRoutine', title: 'Open', arguments: [node] };
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
      node.id = this.idFor(parent, conn, database, 'evt', e.name);
      node.command = { command: 'devbelt.openEvent', title: 'Open', arguments: [node] };
      return node;
    });
  }

}

function formatTableTooltip(t: { table_rows?: string; comment?: string; data_length?: string; index_length?: string; auto_increment?: string }): string {
  const parts: string[] = [];
  if (t.table_rows !== undefined) parts.push(`Rows: ${t.table_rows}`);
  const total = (Number(t.data_length) || 0) + (Number(t.index_length) || 0);
  if (total > 0) parts.push(`Size: ${formatSize(total)}`);
  if (t.auto_increment) parts.push(`Auto Increment: ${t.auto_increment}`);
  if (t.comment) parts.push(`Comment: ${t.comment}`);
  return parts.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}