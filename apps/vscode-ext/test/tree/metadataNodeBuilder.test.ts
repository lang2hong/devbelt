import { describe, expect, it, vi } from 'vitest';
import { TreeItemCollapsibleState } from 'vscode';
import { MetadataNodeBuilder } from '../../src/tree/metadataNodeBuilder';
import { DbTreeNode, NodeKind } from '../../src/tree/dbTreeNode';

vi.mock('vscode', () => ({
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  ThemeIcon: class {},
  TreeItem: class {
    label: string;
    collapsibleState: number;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  ThemeColor: class {},
}));

const conn: any = { id: 'c1', database: 'test', dbType: 'MYSQL', host: 'h', name: 'n' };
const parent = new DbTreeNode('db', TreeItemCollapsibleState.Collapsed, NodeKind.Database, conn);

const metadata: any = {
  getTables: async () => [
    { name: 'users', table_rows: '42' },
    { name: 'audit', comment: '审计表' },
    { name: 'empty' },
  ],
  getViews: async () => [{ name: 'v_active' }],
  getFunctions: async () => [{ name: 'proc_x', type: 'PROCEDURE' }],
  getEvents: async () => [{ name: 'daily_job' }],
  getColumns: async () => [],
};

describe('MetadataNodeBuilder', () => {
  const builder = new MetadataNodeBuilder(metadata);

  it('table 节点：行数/comment 描述 + previewTable command', async () => {
    const nodes = await builder.build('table', conn, 'test', parent);
    expect(nodes).toHaveLength(3);
    expect(nodes[0].kind).toBe(NodeKind.Table);
    expect(nodes[0].description).toBe('42 rows');
    expect(nodes[1].description).toBe('审计表');
    expect(nodes[2].description).toBeUndefined();
    expect(nodes[0].command?.command).toBe('devbelt.previewTable');
    expect(nodes[0].collapsible).toBe(TreeItemCollapsibleState.Collapsed);
  });

  it('view 节点可折叠为空 + previewView command', async () => {
    const nodes = await builder.build('view', conn, 'test', parent);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe(NodeKind.View);
    expect(nodes[0].collapsible).toBe(TreeItemCollapsibleState.None);
    expect(nodes[0].command?.command).toBe('devbelt.previewView');
  });

  it('function 节点携带 routineType + openRoutine command', async () => {
    const nodes = await builder.build('function', conn, 'test', parent);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe(NodeKind.Routine);
    expect(nodes[0].routineType).toBe('PROCEDURE');
    expect(nodes[0].command?.command).toBe('devbelt.openRoutine');
  });

  it('event 节点 + openEvent command', async () => {
    const nodes = await builder.build('event', conn, 'test', parent);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe(NodeKind.Event);
    expect(nodes[0].command?.command).toBe('devbelt.openEvent');
  });

  /**
   * 用户不再是树节点：`getUsers()` 与库无关，挂在库下会让 MySQL 的每个库
   * 各显示一份相同的用户列表。改由连接右键的用户管理面板承载。
   */
  it('user 分类不再构建节点', async () => {
    const nodes = await builder.build('user' as any, conn, 'test', parent);
    expect(nodes).toEqual([]);
  });

  it('不支持的分类返回空列表', async () => {
    const nodes = await builder.build('query' as any, conn, 'test', parent);
    expect(nodes).toEqual([]);
  });
});