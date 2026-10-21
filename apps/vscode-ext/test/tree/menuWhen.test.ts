import { describe, expect, it, vi } from 'vitest';
import { TreeItemCollapsibleState } from 'vscode';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DbTreeNode, NodeKind, type CategoryType } from '../../src/tree/dbTreeNode';

vi.mock('vscode', () => ({
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
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

const DB_TYPES = ['MYSQL', 'PG', 'SQLITE'] as const;
const CATEGORIES: CategoryType[] = [
  'table', 'view', 'function', 'event', 'query', 'index', 'trigger', 'foreignKey',
];

/**
 * 枚举 DbTreeNode 能产生的全部 contextValue。
 *
 * 菜单 when 表达式匹配的是 contextValue 字符串；TS 编译不会校验它们，
 * 拼错一个字母的后果是「命令右键不可见」且毫无报错。这份全集就是校验依据。
 */
function allContextValues(): Set<string> {
  const values = new Set<string>();
  const mk = (
    collapsible: number,
    kind: NodeKind,
    conn: any,
    categoryType?: CategoryType,
  ): void => {
    const node = new DbTreeNode('x', collapsible, kind, conn, undefined, undefined, categoryType);
    if (node.contextValue) values.add(node.contextValue);
  };

  // 分组节点没有连接
  mk(TreeItemCollapsibleState.Collapsed, NodeKind.Group, undefined);

  // P7：Redis 连接节点 + 逻辑库节点（S3）。
  const redisConn: any = { id: 'r', host: 'h', dbType: 'REDIS' };
  mk(TreeItemCollapsibleState.None, NodeKind.Connection, redisConn);
  mk(TreeItemCollapsibleState.Collapsed, NodeKind.Connection, redisConn);
  mk(TreeItemCollapsibleState.None, NodeKind.RedisDb, redisConn);
  // S5-3：只读键导航节点（文件夹/键/加载更多）。
  mk(TreeItemCollapsibleState.Collapsed, NodeKind.RedisKeyFolder, redisConn);
  mk(TreeItemCollapsibleState.None, NodeKind.RedisKey, redisConn);
  mk(TreeItemCollapsibleState.None, NodeKind.RedisKeyLoadMore, redisConn);

  // P8：Elasticsearch 连接节点（含只读 `.ro`）与集群/索引节点。
  const esConn: any = { id: 'es', host: 'h', dbType: 'ELASTICSEARCH' };
  mk(TreeItemCollapsibleState.None, NodeKind.Connection, esConn);
  mk(TreeItemCollapsibleState.Collapsed, NodeKind.Connection, esConn);
  mk(TreeItemCollapsibleState.Collapsed, NodeKind.Connection, { ...esConn, readOnly: true });
  mk(TreeItemCollapsibleState.None, NodeKind.EsClusterInfo, esConn);
  mk(TreeItemCollapsibleState.Collapsed, NodeKind.EsIndexCategory, esConn);
  mk(TreeItemCollapsibleState.None, NodeKind.EsIndex, esConn);

  for (const dbType of DB_TYPES) {
    const conn: any = { id: 'c', host: 'h', dbType };
    // 连接节点：折叠态 = 未打开，展开态 = 已打开
    mk(TreeItemCollapsibleState.None, NodeKind.Connection, conn);
    mk(TreeItemCollapsibleState.Collapsed, NodeKind.Connection, conn);
    for (const kind of Object.values(NodeKind)) {
      if (kind === NodeKind.Connection || kind === NodeKind.Group) continue;
      if (kind === NodeKind.Category) {
        for (const categoryType of CATEGORIES) {
          mk(TreeItemCollapsibleState.Collapsed, kind, conn, categoryType);
        }
        continue;
      }
      mk(TreeItemCollapsibleState.None, kind, conn);
    }
  }
  return values;
}

interface MenuEntry { command?: string; submenu?: string; when?: string; group?: string }

function contextMenus(): MenuEntry[] {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
  const menus = pkg.contributes.menus as Record<string, MenuEntry[]>;
  return [
    ...(menus['view/item/context'] ?? []),
    ...Object.entries(menus)
      .filter(([key]) => key.startsWith('devbelt.'))
      .flatMap(([, items]) => items),
  ];
}

/** 从 when 表达式中取出 viewItem 条件，编译成对 contextValue 的判定函数（支持 `||`）。 */
function viewItemMatcher(when: string): ((value: string) => boolean) | undefined {
  const matchers = when.split('||').map((part): ((value: string) => boolean) | undefined => {
    const eq = part.match(/viewItem\s*==\s*([\w.]+)/);
    if (eq) return (value) => value === eq[1];
    const re = part.match(/viewItem\s*=~\s*\/(.+?)\/(?=\s|$)/);
    if (re) {
      const rx = new RegExp(re[1]);
      return (value) => rx.test(value);
    }
    return undefined;
  }).filter((f): f is (value: string) => boolean => f !== undefined);
  if (!matchers.length) return undefined;
  return (value) => matchers.some((m) => m(value));
}

describe('树右键菜单 when 表达式', () => {
  /**
   * 回归：数据库类型曾经通过 `setContext('devbelt.dbType')` 传递，而那个键由
   * 树的「选中变化」事件异步写入。右键未选中项、或右键与选中项不同时，键里还是
   * 上一个节点的值：在 SQLite 表上会看到 MySQL 专属命令，该出现的命令反而不出现。
   * 类型现在编码进 contextValue，菜单不得再依赖这些全局键。
   */
  it('不再依赖 devbelt.dbType / devbelt.has* 上下文键', () => {
    const offenders = contextMenus()
      .filter((e) => /devbelt\.(dbType|has[A-Z])/.test(e.when || ''))
      .map((e) => `${e.command ?? e.submenu}: ${e.when}`);
    expect(offenders).toEqual([]);
  });

  it('每条 when 都携带 viewItem 条件', () => {
    const missing = contextMenus()
      .filter((e) => !viewItemMatcher(e.when || ''))
      .map((e) => `${e.command ?? e.submenu}: ${e.when}`);
    expect(missing).toEqual([]);
  });

  /**
   * 每条 when 至少要能匹配到一个真实存在的 contextValue。
   * 漏改一条（例如仍写 `viewItem == table` 而节点已是 `table.MYSQL`）
   * 只会表现为命令永远不出现，不会有任何编译或运行时报错。
   */
  it('每条 when 至少匹配一个真实 contextValue', () => {
    const values = [...allContextValues()];
    const dead = contextMenus()
      .filter((e) => {
        const match = viewItemMatcher(e.when || '');
        return match ? !values.some(match) : false;
      })
      .map((e) => `${e.command ?? e.submenu}: ${e.when}`);
    expect(dead).toEqual([]);
  });

  it('contextValue 一律形如 <base>.<DBTYPE>', () => {
    for (const value of allContextValues()) {
      expect(value).toMatch(/^[A-Za-z_]+\.(MYSQL|PG|SQLITE|REDIS|ELASTICSEARCH|NONE)(\.ro)?$/);
    }
  });

  it('只读 Redis 连接：contextValue 带 .ro，写操作菜单不可见、读操作仍可见', () => {
    const ro: any = { id: 'r', host: 'h', dbType: 'REDIS', readOnly: true };
    const menus = contextMenus();
    const whenOf = (cmd: string, base: string): string =>
      menus.find((e) => e.command === cmd && (e.when || '').includes(base))!.when!;

    const keyNode = new DbTreeNode('k', TreeItemCollapsibleState.None, NodeKind.RedisKey, ro);
    expect(keyNode.contextValue).toBe('redisKey.REDIS.ro');
    expect(viewItemMatcher(whenOf('devbelt.redis.renameKey', 'redisKey.REDIS'))!(keyNode.contextValue!)).toBe(false);
    expect(viewItemMatcher(whenOf('devbelt.redis.keyBrowser', 'redisKey.REDIS'))!(keyNode.contextValue!)).toBe(true);

    const dbNode = new DbTreeNode('db0', TreeItemCollapsibleState.Collapsed, NodeKind.RedisDb, ro);
    expect(viewItemMatcher(whenOf('devbelt.redis.newKey', 'redisDb.REDIS'))!(dbNode.contextValue!)).toBe(false);

    const folder = new DbTreeNode('a', TreeItemCollapsibleState.Collapsed, NodeKind.RedisKeyFolder, ro);
    expect(viewItemMatcher(whenOf('devbelt.redis.deleteFolder', 'redisKeyFolder.REDIS'))!(folder.contextValue!)).toBe(false);
    expect(viewItemMatcher(whenOf('devbelt.redis.loadMoreFolderKeys', 'redisKeyFolder.REDIS'))!(folder.contextValue!)).toBe(true);
    expect(viewItemMatcher(whenOf('devbelt.redis.loadAllFolderKeys', 'redisKeyFolder.REDIS'))!(folder.contextValue!)).toBe(true);
  });

  /** SQLite 无用户体系，用户相关命令不得在 SQLite 连接上出现。 */
  it('SQLite 不匹配用户相关菜单', () => {
    const userMenus = contextMenus().filter((e) => /user/i.test(e.command ?? ""));
    expect(userMenus.length).toBeGreaterThan(0);
    const sqliteValues = [...allContextValues()].filter((v) => v.endsWith('.SQLITE'));
    for (const entry of userMenus) {
      const match = viewItemMatcher(entry.when || '');
      if (!match) continue;
      expect(sqliteValues.filter(match), `${entry.command} 在 SQLite 上可见`).toEqual([]);
    }
  });

  /**
   * P8：Elasticsearch 连接菜单。
   * - 集群总览 / REST 控制台在普通与只读连接上都可见（写操作门禁在请求层）；
   * - closeConnection / refreshConnection / openConnection 均覆盖 ELASTICSEARCH（含 `.ro`）。
   */
  it('ES 连接：集群/REST 菜单可见，面板命令覆盖只读变体', () => {
    const menus = contextMenus();
    const whenOf = (cmd: string): string => menus.find((e) => e.command === cmd)!.when!;
    const plain: any = { id: 'es', host: 'h', dbType: 'ELASTICSEARCH' };
    const ro: any = { ...plain, readOnly: true };

    const plainNode = new DbTreeNode('es', TreeItemCollapsibleState.Collapsed, NodeKind.Connection, plain);
    const roNode = new DbTreeNode('es', TreeItemCollapsibleState.Collapsed, NodeKind.Connection, ro);
    expect(plainNode.contextValue).toBe('connectionOpen.ELASTICSEARCH');
    expect(roNode.contextValue).toBe('connectionOpen.ELASTICSEARCH.ro');

    for (const cmd of ['devbelt.es.cluster', 'devbelt.es.rest']) {
      const match = viewItemMatcher(whenOf(cmd))!;
      expect(match(plainNode.contextValue!), `${cmd} 普通连接不可见`).toBe(true);
      expect(match(roNode.contextValue!), `${cmd} 只读连接不可见`).toBe(true);
    }
    for (const cmd of ['devbelt.closeConnection', 'devbelt.refreshConnection']) {
      const match = viewItemMatcher(whenOf(cmd))!;
      expect(match(roNode.contextValue!), `${cmd} 未覆盖只读 ES`).toBe(true);
    }
    const closedRo = new DbTreeNode('es', TreeItemCollapsibleState.None, NodeKind.Connection, ro);
    expect(closedRo.contextValue).toBe('connectionClosed.ELASTICSEARCH.ro');
    expect(viewItemMatcher(whenOf('devbelt.openConnection'))!(closedRo.contextValue!)).toBe(true);
  });

  /**
   * 每个非连接节点都应能刷新与复制名称。
   * 连接节点用 refreshConnection / openConnection（作 refresh 等价），不强制 refreshNode。
   */
  it('每个非连接节点都有 refresh 与 copy 菜单', () => {
    const NON_CONN = [
      'database', 'category_table', 'category_view', 'category_function', 'category_event',
      'category_query', 'category_index', 'category_trigger', 'category_foreignKey',
      'table', 'view', 'column', 'index', 'trigger', 'foreignKey',
      'routine', 'event', 'savedQuery', 'queryFolder', 'group',
    ];
    const values = allContextValues();
    const menus = contextMenus();

    for (const base of NON_CONN) {
      const belongs = (v: string) => v.startsWith(base + '.');
      const applicable = [...values].filter(belongs);
      if (!applicable.length) continue; // 该 base 在任何 dbType 都不存在（如 category_function 无 SQLITE）

      const has = (cmd: string): boolean =>
        menus.some((e) => e.command === cmd && viewItemMatcher(e.when || '')?.(applicable[0]));

      expect(has('devbelt.refreshNode'), `${base} 缺 refresh`).toBe(true);
      expect(has('devbelt.copyNodeName'), `${base} 缺 copy`).toBe(true);
    }
  });
});
