import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    label: string;
    collapsibleState: number;
    contextValue = '';
    id = '';
    description = '';
    tooltip?: unknown;
    command?: unknown;
    iconPath?: unknown;
    resourceUri?: unknown;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  ThemeIcon: class { constructor(public id: string) { /* noop */ } },
  ThemeColor: class {},
  Uri: {
    parse: (s: string) => ({ toString: () => s, scheme: s.split('://')[0], authority: s.split('://')[1] ?? '' }),
    joinPath: (base: { toString(): string }, ...parts: string[]) => ({ toString: () => [base.toString(), ...parts].join('/') }),
  },
  EventEmitter: class {
    private readonly ls: ((x: unknown) => void)[] = [];
    event = (l: (x: unknown) => void) => { this.ls.push(l); return { dispose(): void { /* noop */ } }; };
    fire(x?: unknown): void { for (const l of this.ls) l(x); }
    dispose(): void { /* noop */ }
  },
  window: { showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

import { DbTreeDataProvider } from '../../src/tree/dbTreeDataProvider';
import { NodeKind } from '../../src/tree/dbTreeNode';

const conn = { id: 'c1', name: 'My', dbType: 'MYSQL', host: 'h', port: 3306 } as never;

function makeProvider() {
  const store = {
    getVisibleTreeData: () => ({ groups: [], connections: [conn] }),
    get: (id: string) => (id === 'c1' ? conn : undefined),
    onChanged: () => ({ dispose() { /* noop */ } }),
  };
  const extUri = { toString: () => 'ext' } as never;
  return new DbTreeDataProvider(store as never, {} as never, undefined, extUri);
}

function iconOf(node: { iconPath?: unknown }): string {
  const p = node.iconPath as { light?: { toString(): string } } | undefined;
  return p?.light?.toString() ?? '';
}

describe('连接节点图标状态', () => {
  it('未打开=dim，打开=彩色，当前选中且已打开=active(绿点)', async () => {
    const provider = makeProvider();
    let node = (await provider.getChildren()).find((n) => n.kind === NodeKind.Connection)!;
    expect(iconOf(node)).toContain('db-mysql-dim.svg');

    provider.markOpen('c1');
    node = (await provider.getChildren()).find((n) => n.kind === NodeKind.Connection)!;
    expect(iconOf(node)).toContain('db-mysql.svg');
    expect(iconOf(node)).not.toContain('-dim');
    expect(iconOf(node)).not.toContain('-active');

    provider.setActiveConnection('c1');
    node = (await provider.getChildren()).find((n) => n.kind === NodeKind.Connection)!;
    expect(iconOf(node)).toContain('db-mysql-active.svg');
  });
});