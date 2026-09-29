import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    label: string;
    collapsibleState: number;
    contextValue = '';
    id = '';
    description = '';
    command?: unknown;
    iconPath?: unknown;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  ThemeIcon: class { constructor(public id: string) { /* noop */ } },
  ThemeColor: class {},
  Uri: {
    parse: (s: string) => ({ toString: () => s }),
    joinPath: (base: { toString(): string }, ...parts: string[]) => ({ toString: () => [base.toString(), ...parts].join('/') }),
  },
  EventEmitter: class {
    event = () => ({ dispose(): void { /* noop */ } });
    fire(): void { /* noop */ }
    dispose(): void { /* noop */ }
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    createOutputChannel: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), dispose: vi.fn(), appendLine: vi.fn() }),
  },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

import { DbTreeDataProvider } from '../../src/tree/dbTreeDataProvider';
import { DbTreeNode, NodeKind } from '../../src/tree/dbTreeNode';

/**
 * B1 治理：Schema 层只对声明 `capabilities.schemas` 的方言出现。
 *
 * 这条断言防的是「PG 的 Schema 分支被硬编码进树」——MySQL/SQLite 一旦多出一层
 * Schema 节点，既无对应方言能力，也会破坏两者原有的库→分类层级。
 */
function makeProvider(getSchemas: () => Promise<string[]>): DbTreeDataProvider {
  const manager: any = {
    connectSql: async () => ({ metadata: { getSchemas }, capabilities: { operations: [] } }),
  };
  const store: any = { get: () => undefined, list: () => [] };
  return new DbTreeDataProvider(store, manager);
}

function dbNode(dbType: string): DbTreeNode {
  const conn: any = { id: `${dbType}-1`, name: dbType, dbType, host: 'h', port: 1, database: 'app' };
  const n = new DbTreeNode('app', 1 as any, NodeKind.Database, conn);
  n.id = `${conn.id}:sqldb:app`;
  return n;
}

describe('B1 Schema 层方言门控', () => {
  it('MySQL 库节点下不出现 Schema 节点', async () => {
    const provider = makeProvider(async () => ['public']);
    const kids = await (provider as any).buildDatabaseChildren(dbNode('MYSQL'));
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.some((n: DbTreeNode) => n.kind === NodeKind.Schema)).toBe(false);
    expect(kids.every((n: DbTreeNode) => n.kind === NodeKind.Category)).toBe(true);
  });

  it('PG 库节点下出现 Schema 层（public 置顶）+ 库级「查询」分类', async () => {
    const provider = makeProvider(async () => ['sales', 'public', 'archive']);
    const kids = await (provider as any).buildDatabaseChildren(dbNode('PG'));
    const schemaNodes = kids.filter((n: DbTreeNode) => n.kind === NodeKind.Schema);
    expect(schemaNodes.map((n: DbTreeNode) => n.label)).toEqual(['public', 'sales', 'archive']);
    expect(schemaNodes.every((n: DbTreeNode) => n.schema)).toBe(true);
    // 「查询」分类挂在 Database 节点（不挂在每个 schema 下，避免 id 冲突与重复）。
    const queryCats = kids.filter((n: DbTreeNode) => n.kind === NodeKind.Category && n.categoryType === 'query');
    expect(queryCats).toHaveLength(1);
  });

  it('B4：PG Database 节点携带 database=库名（恢复/导入/导出/备份据此命中）', async () => {
    const manager: any = {
      connectSql: async () => ({
        capabilities: { multiDatabaseExplorer: true, schemas: true, operations: [] },
        metadata: { getDatabases: async () => ['app', 'other'] },
      }),
    };
    const store: any = { get: () => undefined, list: () => [] };
    const provider = new DbTreeDataProvider(store, manager);
    const conn: any = { id: 'pg-1', name: 'p', dbType: 'PG', host: 'h', port: 5432, database: 'app' };
    const el = new DbTreeNode('p', 1 as any, NodeKind.Connection, conn);
    const kids = await (provider as any).buildConnectionChildren(el);
    expect(kids.map((n: DbTreeNode) => [n.label, n.database])).toEqual([['app', 'app'], ['other', 'other']]);
  });

  it('跨 schema 同层节点 id 唯一（Schema 及其分类派生自父节点 id）', async () => {
    const provider = makeProvider(async () => ['public', 'sales']);
    const kids = await (provider as any).buildDatabaseChildren(dbNode('PG'));
    const schemas = kids.filter((n: DbTreeNode) => n.kind === NodeKind.Schema);
    expect(new Set(schemas.map((n: DbTreeNode) => n.id)).size).toBe(schemas.length);
    expect(schemas.map((n: DbTreeNode) => n.id).join(',')).toContain(':schema:public');
    // 两个 schema 的分类节点 id 不能相撞。
    const cats = schemas.flatMap((s: DbTreeNode) => (provider as any).buildSchemaChildren(s));
    expect(new Set(cats.map((c: DbTreeNode) => c.id)).size).toBe(cats.length);
  });

  it('PG Schema 节点下不出现「查询」分类（避免跨 schema id 冲突）', async () => {
    const provider = makeProvider(async () => ['public']);
    const s = new DbTreeNode('sales', 1 as any, NodeKind.Schema, dbNode('PG').conn);
    s.schema = 'sales';
    s.id = 'pg-1:sqldb:app:schema:sales';
    const kids = (provider as any).buildSchemaChildren(s);
    expect(kids.some((n: DbTreeNode) => n.categoryType === 'query')).toBe(false);
    expect(kids.some((n: DbTreeNode) => n.categoryType === 'table')).toBe(true);
  });
});