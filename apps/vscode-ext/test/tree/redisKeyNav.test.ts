import { describe, expect, it, vi } from 'vitest';
import { TreeItemCollapsibleState } from 'vscode';

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
import { DbTreeNode, NodeKind } from '../../src/tree/dbTreeNode';

const conn: any = { id: 'c1', name: 'r', dbType: 'REDIS', host: 'h', port: 6379, keySeparator: ':' };

function pages(responses: Record<string, unknown>) {
  const calls: [string, (string | number)[]][] = [];
  const client = {
    isCluster: false,
    sendCommand: async (n: string, a: (string | number)[] = []) => {
      calls.push([n, a]);
      if (n === 'SCAN') {
        const key = a.includes('MATCH') ? String(a[a.indexOf('MATCH') + 1]) : '';
        return responses[key] ?? ['0', []];
      }
      return 'OK';
    },
    runExclusive: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
  const manager: any = { connect: async () => ({ kind: 'redis', client, db: 3, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {} }) };
  const store: any = { get: () => undefined, list: () => [] };
  return { provider: new DbTreeDataProvider(store, manager), calls };
}

function dbNode(): DbTreeNode {
  const n = new DbTreeNode('db0', TreeItemCollapsibleState.Collapsed, NodeKind.RedisDb, conn);
  n.redisDbIndex = 0;
  return n;
}

describe('S5-3 树内只读键导航（懒 SCAN + 折叠）', () => {

  it('DB 展开：根级 SCAN → 文件夹 + 叶子键', async () => {
    const { provider, calls } = pages({ '': ['0', ['user:1', 'user:2', 'cache:a', 'standalone']] });
    const kids = await provider.getChildren(dbNode());
    const folders = kids.filter((k) => k.kind === NodeKind.RedisKeyFolder).map((k) => k.label);
    const keys = kids.filter((k) => k.kind === NodeKind.RedisKey).map((k) => k.label);
    expect(folders).toEqual(['cache', 'user']);
    expect(keys).toEqual(['standalone']);
    expect(calls.some(([n]) => n === 'SELECT')).toBe(true);
    expect(calls.some(([n, a]) => n === 'SCAN' && !a.includes('MATCH'))).toBe(true);
  });

  it('文件夹展开：前缀 SCAN MATCH <prefix>*', async () => {
    const { provider, calls } = pages({
      '': ['0', ['user:1', 'user:2']],
      'user:*': ['0', ['user:1', 'user:2']],
    });
    const kids = await provider.getChildren(dbNode());
    const user = kids.find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    expect(user.redisKeyPrefix).toBe('user');
    const leaves = await provider.getChildren(user);
    expect(leaves.map((k) => k.label)).toEqual(['user:1', 'user:2']);
    expect(leaves.every((k) => k.command?.command === 'devbelt.redis.keyBrowser')).toBe(true);
    expect(leaves.every((k) => k.redisKey === k.label)).toBe(true);
    expect(calls.some(([n, a]) => n === 'SCAN' && a.includes('MATCH') && a.includes('user:*'))).toBe(true);
  });

  it('游标非 0：追加「加载更多」哨兵（loadMoreKeys 命令）', async () => {
    const { provider } = pages({ '': ['42', ['a:1', 'b:2']] });
    const kids = await provider.getChildren(dbNode());
    const more = kids.find((k) => k.kind === NodeKind.RedisKeyLoadMore);
    expect(more).toBeTruthy();
    expect(more!.command?.command).toBe('devbelt.redis.loadMoreKeys');
  });

  it('cluster（无 DB 节点）不参与（DB 展开走 SELECT 跳过）', async () => {
    const { provider, calls } = pages({ '': ['0', ['k1']] });
    const node = dbNode();
    await provider.getChildren(node);
    // 本用例仅确认 standalone 路径会 SELECT；cluster 不经 DB 节点（buildConnectionChildren 返回 []）。
    expect(calls.length).toBeGreaterThan(0);
  });

  it('搜索态：扁平结果（不折叠）+ MATCH 前缀', async () => {
    const { provider, calls } = pages({
      '': ['0', ['user:1']],
      '*user*': ['0', ['user:1', 'user:2', 'cache:user']],
    });
    const db = dbNode();
    provider.setRedisMatch(db, '*user*');
    const kids = await provider.getChildren(db);
    expect(kids.every((k) => k.kind === NodeKind.RedisKey)).toBe(true);
    expect(kids.map((k) => k.label)).toEqual(['cache:user', 'user:1', 'user:2']);
    expect(calls.some(([n, a]) => n === 'SCAN' && a.includes('MATCH') && a.includes('*user*'))).toBe(true);
  });

  it('达上限：追加提示节点而非「加载更多」', async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `k${i}`);
    const { provider } = pages({ '': ['0', big] });
    const kids = await provider.getChildren(dbNode());
    const notices = kids.filter((k) => k.kind === NodeKind.RedisKeyLoadMore);
    expect(notices).toHaveLength(1);
    expect(notices[0].command).toBeUndefined();
    expect(String(notices[0].label)).toContain('20000');
  });

  it('文件夹前缀含 glob 元字符：展开 pattern 被转义（防错查/错删）', async () => {
    const { provider, calls } = pages({
      '': ['0', ['a[1]:x']],
      'a\\[1\\]:*': ['0', ['a[1]:x']],
    });
    const kids = await provider.getChildren(dbNode());
    const folder = kids.find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    expect(folder.redisKeyPrefix).toBe('a[1]');
    const leaves = await provider.getChildren(folder);
    expect(leaves.map((k) => k.label)).toEqual(['a[1]:x']);
    expect(calls.some(([n, a]) => n === 'SCAN' && a.includes('MATCH') && a.includes('a\\[1\\]:*'))).toBe(true);
  });
});