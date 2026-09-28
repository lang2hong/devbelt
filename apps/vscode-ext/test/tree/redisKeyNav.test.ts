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
import { l10n } from '../../src/i18n';

const conn: any = { id: 'c1', name: 'r', dbType: 'REDIS', host: 'h', port: 6379, keySeparator: ':' };
const clusterConn: any = { id: 'cc', name: 'r', dbType: 'REDIS', host: 'h', port: 6379, keySeparator: ':', redisMode: 'cluster' };

type ScanReply = [string, string[]];

/** 构造 mock redis client；`scan` 依据 SCAN 参数返回一页。 */
function makeClient(
  scan: (args: (string | number)[]) => ScanReply,
  opts: { cluster?: boolean; nodes?: unknown[] } = {},
) {
  return {
    isCluster: !!opts.cluster,
    mode: opts.cluster ? 'cluster' : 'standalone',
    db: 0,
    nodes: () => opts.nodes ?? [],
    sendCommand: async (n: string, a: (string | number)[] = []) => (n === 'SCAN' ? scan(a) : 'OK'),
    runExclusive: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    info: async () => '',
  };
}

function makeProvider(client: any): DbTreeDataProvider {
  const manager: any = {
    connect: async () => ({ kind: 'redis', client, db: 0, mode: client.mode, readOnly: false, isAlive: () => true, close: () => {} }),
  };
  const store: any = { get: () => undefined, list: () => [] };
  return new DbTreeDataProvider(store, manager);
}

function dbNode(c: any = conn): DbTreeNode {
  const n = new DbTreeNode('db0', TreeItemCollapsibleState.Collapsed, NodeKind.RedisDb, c);
  n.redisDbIndex = 0;
  return n;
}

const matchOf = (a: (string | number)[]): string | undefined =>
  a.includes('MATCH') ? String(a[a.indexOf('MATCH') + 1]) : undefined;

describe('D* 键树（根扁平 SCAN + 客户端折叠）', () => {
  it('DB 展开：根级单页 SCAN → 文件夹 + 叶子键', async () => {
    const calls: (string | number)[][] = [];
    const provider = makeProvider(makeClient((a) => { calls.push(a); return ['0', ['user:1', 'user:2', 'cache:a', 'standalone']]; }));
    const kids = await provider.getChildren(dbNode());
    expect(kids.filter((k) => k.kind === NodeKind.RedisKeyFolder).map((k) => k.label)).toEqual(['cache', 'user']);
    expect(kids.filter((k) => k.kind === NodeKind.RedisKey).map((k) => k.label)).toEqual(['standalone']);
    expect(calls).toHaveLength(1);
  });

  it('文件夹展开：不再发 SCAN，直接由根扁平集折叠', async () => {
    let scans = 0;
    const provider = makeProvider(makeClient(() => { scans++; return ['0', ['user:1', 'user:2']]; }));
    const kids = await provider.getChildren(dbNode());
    const user = kids.find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    scans = 0;
    const leaves = await provider.getChildren(user);
    expect(scans).toBe(0);
    expect(leaves.map((k) => k.label)).toEqual(['user:1', 'user:2']);
    expect(leaves.every((k) => k.command?.command === 'devbelt.redis.keyBrowser')).toBe(true);
  });

  it('前缀字符串重叠/兄弟叶子：不产生自引用子文件夹（无父↔子循环）', async () => {
    const provider = makeProvider(makeClient(() => ['0', ['a:x', 'ab:y', 'user', 'user:1']]));
    const db = dbNode();
    const root = await provider.getChildren(db);
    const folderA = root.find((k) => k.kind === NodeKind.RedisKeyFolder && k.label === 'a')!;
    const folderAb = root.find((k) => k.kind === NodeKind.RedisKeyFolder && k.label === 'ab')!;
    const folderUser = root.find((k) => k.kind === NodeKind.RedisKeyFolder && k.label === 'user')!;

    // `ab:y` 不得钻入 `a`；`user`（无分隔的兄弟叶子）不得钻入 `user` 文件夹。
    const kidsA = await provider.getChildren(folderA);
    expect(kidsA.filter((k) => k.kind === NodeKind.RedisKeyFolder)).toHaveLength(0);
    expect(kidsA.map((k) => k.label)).toEqual(['a:x']);

    expect((await provider.getChildren(folderAb)).map((k) => k.label)).toEqual(['ab:y']);
    expect((await provider.getChildren(folderUser)).map((k) => k.label)).toEqual(['user:1']);
    // 根层 `user` 是无分隔叶子，应与 `user` 文件夹并存且互不嵌套。
    expect(root.filter((k) => k.kind === NodeKind.RedisKey).map((k) => k.label)).toEqual(['user']);
  });

  it('游标非 0：根层追加唯一「加载更多」哨兵（loadMoreKeys 命令）', async () => {
    const provider = makeProvider(makeClient(() => ['42', ['a:1', 'b:2']]));
    const kids = await provider.getChildren(dbNode());
    const more = kids.filter((k) => k.kind === NodeKind.RedisKeyLoadMore);
    expect(more).toHaveLength(1);
    expect(more[0].command?.command).toBe('devbelt.redis.loadMoreKeys');
  });

  it('根层扫完：无「加载更多」，改显示不可点击的「已全部加载」哨兵', async () => {
    const provider = makeProvider(makeClient(() => ['0', ['k1', 'k2']]));
    const kids = await provider.getChildren(dbNode());
    expect(kids.some((k) => k.kind === NodeKind.RedisKeyLoadMore)).toBe(false);
    const all = kids.filter((k) => k.kind === NodeKind.RedisKeysLoadedAll);
    expect(all).toHaveLength(1);
    expect(all[0].command).toBeUndefined();
  });

  it('「加载更多」带「已加载 N」；点击返回 added/total/done 并在扫完后出哨兵', async () => {
    const pages: ScanReply[] = [['42', ['a:1', 'b:2']], ['0', ['c:3']]];
    const provider = makeProvider(makeClient(() => pages.shift() ?? ['0', []]));
    const db = dbNode();
    const first = await provider.getChildren(db);
    const more = first.find((k) => k.kind === NodeKind.RedisKeyLoadMore)!;
    expect(more.description).toBe(l10n('redis.tree.loadedCount', { count: '2' }));

    const res = await provider.loadMoreRedisKeys(more);
    expect(res).toMatchObject({ added: 1, total: 3, done: true, error: false });

    const after = await provider.getChildren(db);
    expect(after.some((k) => k.kind === NodeKind.RedisKeyLoadMore)).toBe(false);
    expect(after.some((k) => k.kind === NodeKind.RedisKeysLoadedAll)).toBe(true);
  });

  it('扫描失败：保留可点「加载更多」（不误判为扫完、不显示哨兵）', async () => {
    const provider = makeProvider(makeClient(() => { throw new Error('boom'); }));
    const kids = await provider.getChildren(dbNode());
    const more = kids.find((k) => k.kind === NodeKind.RedisKeyLoadMore);
    expect(more?.command?.command).toBe('devbelt.redis.loadMoreKeys');
    expect(kids.some((k) => k.kind === NodeKind.RedisKeysLoadedAll)).toBe(false);
  });

  it('搜索态：扁平结果（不折叠）+ MATCH 前缀', async () => {
    const provider = makeProvider(makeClient((a) => (matchOf(a) ? ['0', ['user:1', 'user:2', 'cache:user']] : ['0', ['user:1']])));
    const db = dbNode();
    provider.setRedisMatch(db, '*user*');
    const kids = await provider.getChildren(db);
    expect(kids.every((k) => k.kind === NodeKind.RedisKey)).toBe(true);
    expect(kids.map((k) => k.label)).toEqual(['cache:user', 'user:1', 'user:2']);
  });

  it('软上限：追加「载入全部」入口节点（而非加载更多）', async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `k${i}`);
    const provider = makeProvider(makeClient(() => ['9', big]));
    const kids = await provider.getChildren(dbNode());
    const nodes = kids.filter((k) => k.kind === NodeKind.RedisKeyLoadMore);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].command?.command).toBe('devbelt.redis.loadAllKeys');
  });

  it('「加载完整文件夹」：按转义前缀 SCAN → 写快照 + 徽章', async () => {
    const pages: ScanReply[] = [['9', ['a[1]:x']], ['0', ['a[1]:y']]];
    const seen: string[] = [];
    const provider = makeProvider(makeClient((a) => {
      const m = matchOf(a);
      if (m) { seen.push(m); return pages.shift() ?? ['0', []]; }
      return ['0', ['a[1]:x']];
    }));
    const kids = await provider.getChildren(dbNode());
    const folder = kids.find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    expect(folder.redisKeyPrefix).toBe('a[1]');
    expect(folder.description).toBe('');

    const complete = await provider.loadFullFolder(folder);
    expect(complete).toBe(true);
    expect(seen).toContain('a\\[1\\]:*'); // glob 已转义，防错查/错删

    const rebuilt = (await provider.getChildren(dbNode())).find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    expect(rebuilt.description).toBe(l10n('redis.tree.completeBadge'));
    const leaves = await provider.getChildren(rebuilt);
    expect(leaves.map((k) => k.label)).toEqual(['a[1]:x', 'a[1]:y']);
  });

  it('「载入全部」：链页扫到游标归零', async () => {
    const seq: ScanReply[] = [['1', ['a:1']], ['2', ['a:2']], ['0', ['a:3']]];
    const provider = makeProvider(makeClient(() => seq.shift() ?? ['0', []]));
    const res = await provider.loadAllRedisKeys(dbNode());
    expect(res.done).toBe(true);
    expect(res.scanned).toBe(3);
    const db = dbNode();
    const folder = (await provider.getChildren(db)).find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    expect(folder.label).toBe('a');
    expect((await provider.getChildren(folder)).map((k) => k.label)).toEqual(['a:1', 'a:2', 'a:3']);
  });

  it('「载入全部」：取消信号立即中断', async () => {
    const provider = makeProvider(makeClient(() => ['1', ['a:1']]));
    const res = await provider.loadAllRedisKeys(dbNode(), { isCancellationRequested: true } as any);
    expect(res.done).toBe(false);
    expect(res.scanned).toBe(0);
  });

  it('「载入全部」取消：保留已加载键（不重置覆盖）', async () => {
    const seq: ScanReply[] = [['5', ['a:1']]];
    const provider = makeProvider(makeClient(() => seq.shift() ?? ['0', []]));
    const db = dbNode();
    await provider.getChildren(db); // 首次展开加载一页 a:1，游标 '5'
    const res = await provider.loadAllRedisKeys(db, { isCancellationRequested: true } as any);
    expect(res.done).toBe(false);
    expect(res.scanned).toBe(1);
    const folder = (await provider.getChildren(db)).find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    expect(folder.label).toBe('a');
    expect((await provider.getChildren(folder)).map((k) => k.label)).toEqual(['a:1']);
  });

  it('「载入全部」：达硬上限停止并标记 capped', async () => {
    let n = 0;
    const provider = makeProvider(makeClient(() => ['1', Array.from({ length: 500 }, () => `k${n++}`)]));
    const res = await provider.loadAllRedisKeys(dbNode());
    expect(res.capped).toBe(true);
    expect(res.done).toBe(false);
    expect(res.scanned).toBe(100000);
  });

  it('「载入全部」：游标已归零（已扫完）直接返回，不再重扫', async () => {
    const seq: ScanReply[] = [['0', ['a:1']]];
    const provider = makeProvider(makeClient(() => seq.shift() ?? ['1', ['should_not_happen']]));
    const db = dbNode();
    await provider.getChildren(db); // 首次展开即扫完：cursor '0'
    const res = await provider.loadAllRedisKeys(db);
    expect(res.done).toBe(true);
    expect(res.scanned).toBe(1);
  });

  it('「加载完整文件夹」达硬上限截断：返回 false 且不落快照', async () => {
    let n = 0;
    const provider = makeProvider(makeClient((a) => (matchOf(a) ? ['1', Array.from({ length: 500 }, () => `a:${n++}`)] : ['0', ['a:1']])));
    const db = dbNode();
    const folder = (await provider.getChildren(db)).find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    const complete = await provider.loadFullFolder(folder);
    expect(complete).toBe(false);
    const rebuilt = (await provider.getChildren(db)).find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    expect(rebuilt.description).toBe('');
  });

  it('cluster 载入全部：跳过已归零的 master', async () => {
    const scans: string[] = [];
    const m1 = { call: async (cmd: string) => { if (cmd === 'SCAN') scans.push('m1'); return ['0', ['k1']]; } };
    let m2c = '5';
    const m2 = {
      call: async (cmd: string) => {
        if (cmd !== 'SCAN') return [];
        const r: ScanReply = [m2c, m2c === '5' ? ['k2'] : ['k3']];
        m2c = '0';
        return r;
      },
    };
    const provider = makeProvider(makeClient(() => ['0', []], { cluster: true, nodes: [m1, m2] }));
    const db = dbNode(clusterConn);
    await provider.getChildren(db); // m1→0（完成），m2→5
    const m1Before = scans.filter((s) => s === 'm1').length;
    const res = await provider.loadAllRedisKeys(db);
    expect(res.done).toBe(true);
    expect(scans.filter((s) => s === 'm1').length).toBe(m1Before); // 不再重扫 m1
  });

  it('「加载完整文件夹」取消：不写快照（回退根折叠、无徽章）', async () => {
    const provider = makeProvider(makeClient((a) => (matchOf(a) ? ['5', ['a:1']] : ['0', ['a:1']])));
    const db = dbNode();
    const folder = (await provider.getChildren(db)).find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    const complete = await provider.loadFullFolder(folder, { isCancellationRequested: true } as any);
    expect(complete).toBe(false);
    const rebuilt = (await provider.getChildren(db)).find((k) => k.kind === NodeKind.RedisKeyFolder)!;
    expect(rebuilt.description).toBe('');
    expect((await provider.getChildren(rebuilt)).map((k) => k.label)).toEqual(['a:1']);
  });

  it('standalone 每页短锁：SELECT 与 SCAN 同锁内，多页仍正确', async () => {
    const calls: string[] = [];
    const seq: ScanReply[] = [['1', ['a:1']], ['0', ['a:2']]];
    const client = makeClient(() => seq.shift() ?? ['0', []]);
    const orig = client.sendCommand;
    client.sendCommand = async (n: string, a: (string | number)[] = []) => { calls.push(n); return orig(n, a); };
    const provider = makeProvider(client);
    const db = new DbTreeNode('db3', TreeItemCollapsibleState.Collapsed, NodeKind.RedisDb, conn);
    db.redisDbIndex = 3;
    const res = await provider.loadAllRedisKeys(db);
    expect(res.done).toBe(true);
    expect(res.scanned).toBe(2);
    expect(calls.filter((c) => c === 'select')).toHaveLength(1);
  });

  it('写操作后：仅降级受影响祖先文件夹的完整性，其它完整快照保留', async () => {
    const provider = makeProvider(makeClient((a) => {
      const m = matchOf(a);
      if (m === 'a:*') return ['0', ['a:1']];
      if (m === 'b:*') return ['0', ['b:1']];
      return ['0', ['a:1', 'b:1']];
    }));
    const db = dbNode();
    const folders = (await provider.getChildren(db)).filter((k) => k.kind === NodeKind.RedisKeyFolder);
    const a = folders.find((k) => k.label === 'a')!;
    const b = folders.find((k) => k.label === 'b')!;
    await provider.loadFullFolder(a);
    await provider.loadFullFolder(b);

    let rebuilt = (await provider.getChildren(db)).filter((k) => k.kind === NodeKind.RedisKeyFolder);
    expect(rebuilt.find((k) => k.label === 'a')!.description).toBe(l10n('redis.tree.completeBadge'));
    expect(rebuilt.find((k) => k.label === 'b')!.description).toBe(l10n('redis.tree.completeBadge'));

    const affected = new DbTreeNode('a:1', TreeItemCollapsibleState.None, NodeKind.RedisKey, conn, undefined, db);
    affected.redisDbIndex = 0;
    affected.redisKey = 'a:1';
    await provider.refreshRedisAfterMutation(affected);

    rebuilt = (await provider.getChildren(db)).filter((k) => k.kind === NodeKind.RedisKeyFolder);
    expect(rebuilt.find((k) => k.label === 'a')!.description).toBe(''); // 降级为「部分」
    expect(rebuilt.find((k) => k.label === 'b')!.description).toBe(l10n('redis.tree.completeBadge'));
  });

  it('cluster：根层逐 master SCAN，per-master count 按 master 数均分', async () => {
    const counts: number[] = [];
    const master = (name: string) => ({
      call: async (cmd: string, ...args: (string | number)[]) => {
        if (cmd === 'SCAN') counts.push(Number(args[args.length - 1]));
        return ['0', [name]];
      },
    });
    const provider = makeProvider(makeClient(() => ['0', []], { cluster: true, nodes: [master('k1'), master('k2'), master('k3')] }));
    const n = dbNode(clusterConn);
    const kids = await provider.getChildren(n);
    expect(kids.filter((k) => k.kind === NodeKind.RedisKey).map((k) => k.label).sort()).toEqual(['k1', 'k2', 'k3']);
    expect(counts).toEqual([167, 167, 167]); // ceil(500 / 3)
  });

  it('cluster：游标未归零 → 仍有「加载更多」', async () => {
    const master = (name: string, cursor: string) => ({
      call: async (cmd: string) => (cmd === 'SCAN' ? [cursor, [name]] : []),
    });
    const provider = makeProvider(makeClient(() => ['0', []], { cluster: true, nodes: [master('k1', '5'), master('k2', '0')] }));
    const kids = await provider.getChildren(dbNode(clusterConn));
    expect(kids.some((k) => k.kind === NodeKind.RedisKeyLoadMore && !!k.command)).toBe(true);
  });

  it('cluster 连接展开出合成 Keys 节点（RedisDb）', async () => {
    const provider = makeProvider(makeClient(() => ['0', []], { cluster: true, nodes: [] }));
    const connNode = new DbTreeNode('r', TreeItemCollapsibleState.Collapsed, NodeKind.Connection, clusterConn);
    const kids = await provider.getChildren(connNode);
    expect(kids).toHaveLength(1);
    expect(kids[0].kind).toBe(NodeKind.RedisDb);
    expect(kids[0].label).toBe(l10n('redis.tree.clusterKeys'));
  });
});