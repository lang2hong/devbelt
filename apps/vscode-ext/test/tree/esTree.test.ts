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
  ThemeIcon: class {
    constructor(public id: string, public color?: unknown) { /* noop */ }
  },
  ThemeColor: class { constructor(public id: string) { /* noop */ } },
  Uri: { parse: (s: string) => ({ toString: () => s }), joinPath: (b: { toString(): string }, ...p: string[]) => ({ toString: () => [b.toString(), ...p].join('/') }) },
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

vi.mock('../../src/utils/diagnostics', () => ({ diagError: vi.fn(), diagWarn: vi.fn(), diagInfo: vi.fn() }));

import { DbTreeDataProvider } from '../../src/tree/dbTreeDataProvider';
import { DbTreeNode, NodeKind } from '../../src/tree/dbTreeNode';
import { diagError } from '../../src/utils/diagnostics';

/** P8 S3：ES 连接/索引类别节点的层级与索引列表懒加载。 */
function makeProvider(request: (method: string, path: string, body: unknown, query: any) => any) {
  const calls: { method: string; path: string; query: any }[] = [];
  const session = {
    kind: 'elasticsearch',
    es: {
      request: async (method: string, path: string, body: unknown, query: any) => {
        calls.push({ method, path, query });
        return request(method, path, body, query);
      },
    },
  };
  const manager: any = { connect: async () => session };
  const store: any = { get: () => undefined, list: () => [] };
  return { provider: new DbTreeDataProvider(store, manager), calls };
}

function esConnNode(readOnly = false): DbTreeNode {
  const conn: any = { id: 'es-1', name: 'ES', dbType: 'ELASTICSEARCH', host: 'localhost', port: 9200, readOnly };
  return new DbTreeNode('ES', 1 as any, NodeKind.Connection, conn);
}

const okRows = [
  { index: 'zzz', health: 'red', status: 'open', pri: '1', rep: '0', 'docs.count': '3', 'store.size': '1kb' },
  { index: 'aaa', health: 'green', status: 'open', pri: '1', rep: '0', 'docs.count': '42', 'store.size': '12kb' },
];

describe('ES 树（P8 S3）', () => {
  it('连接子节点：集群 + 索引类别', async () => {
    const { provider } = makeProvider(() => ({ status: 200, headers: {}, body: [], tookMs: 1 }));
    const kids = await (provider as any).buildConnectionChildren(esConnNode());
    expect(kids.map((n: DbTreeNode) => n.kind)).toEqual([NodeKind.EsClusterInfo, NodeKind.EsIndexCategory]);
    expect(kids[0].command?.command).toBe('devbelt.es.cluster');
    expect(kids[1].command?.command).toBe('devbelt.es.indices');
  });

  it('索引类别子节点：cat/indices 懒加载 + 名称排序 + health 色标/描述', async () => {
    const { provider, calls } = makeProvider(() => ({ status: 200, headers: {}, body: okRows, tookMs: 1 }));
    const category = new DbTreeNode('Indices', 1 as any, NodeKind.EsIndexCategory, esConnNode().conn, undefined, esConnNode());
    const kids = await (provider as any).buildEsIndexChildren(category);
    expect(calls[0].path).toBe('/_cat/indices');
    expect(calls[0].query).toMatchObject({ format: 'json' });
    expect(kids.map((n: DbTreeNode) => n.label)).toEqual(['aaa', 'zzz']);
    const aaa = kids[0];
    expect(aaa.kind).toBe(NodeKind.EsIndex);
    expect(aaa.esIndexName).toBe('aaa');
    expect(aaa.contextValue).toBe('esIndex.ELASTICSEARCH');
    expect(aaa.command?.command).toBe('devbelt.es.index');
    expect(aaa.description).toContain('green');
    expect(aaa.description).toContain('42 docs');
    expect((aaa.iconPath as any)?.id).toBe('database');
    expect((aaa.iconPath as any)?.color?.id).toBe('charts.green');
    expect((kids[1].iconPath as any)?.color?.id).toBe('charts.red');
  });

  it('只读连接：索引节点 contextValue 带 .ro（菜单可分离）', async () => {
    const { provider } = makeProvider(() => ({ status: 200, headers: {}, body: okRows, tookMs: 1 }));
    const connNode = esConnNode(true);
    const category = new DbTreeNode('Indices', 1 as any, NodeKind.EsIndexCategory, connNode.conn, undefined, connNode);
    const kids = await (provider as any).buildEsIndexChildren(category);
    expect(kids[0].contextValue).toBe('esIndex.ELASTICSEARCH.ro');
  });

  it('cat 请求失败（>=400）→ 空列表 + M3 诊断记录', async () => {
    (diagError as any).mockClear();
    const { provider } = makeProvider(() => ({ status: 500, headers: {}, body: null, tookMs: 1 }));
    const connNode = esConnNode();
    const category = new DbTreeNode('Indices', 1 as any, NodeKind.EsIndexCategory, connNode.conn, undefined, connNode);
    expect(await (provider as any).buildEsIndexChildren(category)).toEqual([]);
    expect(diagError).toHaveBeenCalledWith('ES indices load failed', expect.stringContaining('HTTP 500'));
  });
});