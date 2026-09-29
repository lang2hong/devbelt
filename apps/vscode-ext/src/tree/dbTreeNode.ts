import { TreeItem, TreeItemCollapsibleState, ThemeIcon } from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';

/** 树节点类型枚举 */
export enum NodeKind {
  Group = 'group',
  Connection = 'connection',
  Database = 'database',
  Category = 'category',
  Table = 'table',
  View = 'view',
  Routine = 'routine',
  Event = 'event',
  SavedQuery = 'savedQuery',
  QueryFolder = 'queryFolder',
  Column = 'column',
  Index = 'index',
  Trigger = 'trigger',
  ForeignKey = 'foreignKey',
  /** P7 S3：Redis 逻辑库节点。S5-3：可展开为只读键导航。 */
  RedisDb = 'redisDb',
  /** P7 S5-3：Redis 键导航——按分隔符折叠的文件夹（只读）。 */
  RedisKeyFolder = 'redisKeyFolder',
  /** P7 S5-3：Redis 键导航——具体键（只读，点击开值面板）。 */
  RedisKey = 'redisKey',
  /** P7 S5-3：Redis 键导航——「加载更多」哨兵（下一页 SCAN）。 */
  RedisKeyLoadMore = 'redisKeyLoadMore',
  /** P7 D*：Redis 键树根层扫完的「已全部加载」哨兵（不可点击）。 */
  RedisKeysLoadedAll = 'redisKeysLoadedAll',
  /** B1：PostgreSQL 命名空间（schema）节点。 */
  Schema = 'schema',
}

/** 分类子类型 */
export type CategoryType = 'table' | 'view' | 'function' | 'event' | 'query' | 'index' | 'trigger' | 'foreignKey';

/** 各节点类型的 ThemeIcon id（参考 database-client 图标体系） */
const ICON_MAP: Record<string, string> = {
  [NodeKind.Group]: 'folder',
  [NodeKind.Connection]: 'server',
  [NodeKind.Database]: 'database',
  [NodeKind.Table]: 'split-horizontal',
  [NodeKind.View]: 'menu',
  [NodeKind.Routine]: 'symbol-function',
  [NodeKind.Event]: 'zap',
  [NodeKind.SavedQuery]: 'code',
  [NodeKind.QueryFolder]: 'folder',
  [NodeKind.Column]: 'symbol-field',
  [NodeKind.Index]: 'list-selection',
  [NodeKind.Trigger]: 'zap',
  [NodeKind.ForeignKey]: 'link',
  [NodeKind.RedisDb]: 'database',
  [NodeKind.RedisKeyFolder]: 'folder',
  [NodeKind.RedisKey]: 'symbol-key',
  [NodeKind.RedisKeyLoadMore]: 'ellipsis',
  [NodeKind.RedisKeysLoadedAll]: 'check',
  [NodeKind.Schema]: 'symbol-namespace',
};

/** 分类节点的图标 id（按 categoryType 区分） */
const CATEGORY_ICON: Record<CategoryType, string> = {
  table: 'list-flat',
  view: 'menu',
  function: 'symbol-function',
  event: 'zap',
  query: 'code',
  index: 'list-selection',
  trigger: 'zap',
  foreignKey: 'link',
};

/**
 * 连接树节点。
 * 轻量模型：
 *  - Group：分组节点（携带分组 id）
 *  - Connection：连接节点（携带配置）
 *  - Database：数据库节点
 *  - Category：分类节点（表/视图/函数/事件/查询）
 *  - Table/View/Routine/Event/SavedQuery/Column：元数据展示节点
 */
export class DbTreeNode extends TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsible: TreeItemCollapsibleState,
    public readonly kind: NodeKind,
    public readonly conn?: SavedConnection,
    public readonly groupId?: string,
    public readonly parent?: DbTreeNode,
    /** 分类子类型（仅 Category 节点） */
    public readonly categoryType?: CategoryType,
    /** 所属数据库名（Category/Table/View/Routine/Event 节点携带） */
    public readonly database?: string,
    /** 函数/存储过程类型（仅 Routine 节点：FUNCTION/PROCEDURE） */
    public readonly routineType?: string,
    /** 保存查询 id（仅 SavedQuery 节点） */
    public readonly queryId?: string,
    /** 保存查询文件夹 id（QueryFolder 节点） */
    public readonly queryFolderId?: string,
  ) {
    super(label, collapsible);
    let base: string;
    if (kind === NodeKind.Connection) {
      base = collapsible === TreeItemCollapsibleState.None
        ? 'connectionClosed'
        : 'connectionOpen';
    } else if (kind === NodeKind.Category && categoryType) {
      base = `${kind}_${categoryType}`;
    } else {
      base = kind;
    }
    // 数据库类型编进 contextValue，而不是靠 `setContext('devbelt.dbType')`。
    //
    // 那个键由树的「选中变化」事件异步写入，右键时可能仍是上一个节点的值：
    // 在 SQLite 表上会看到 MySQL 专属命令，或该出现的命令反而不出现。
    // 菜单 when 只能读节点自身的 viewItem，所以类型必须随节点携带。
    // 分组节点没有连接，用 NONE 占位以保证格式统一（`<base>.<TYPE>`）。
    // 只读「Redis」连接追加 `.ro`，供菜单 when 隐藏写操作（写入仍由 RedisClient 只读切面兜底）。
    // 仅限 Redis：SQL 侧菜单未做 `.ro` 容错，且其写入门禁在运行期由 sqlSafety 兜底。
    const roSuffix = conn?.readOnly && conn.dbType === DatabaseType.REDIS ? '.ro' : '';
    this.contextValue = `${base}.${conn?.dbType ?? 'NONE'}${roSuffix}`;
    // 图标：Category 按 categoryType 选，其余按 kind 选
    const iconId = kind === NodeKind.Category && categoryType
      ? CATEGORY_ICON[categoryType]
      : ICON_MAP[kind];
    if (iconId) {
      this.iconPath = new ThemeIcon(iconId);
    }
  }

  /** Redis 逻辑库序号（仅 RedisDb 节点，构造后赋值）。 */
  public redisDbIndex?: number;
  /** Redis 键名（仅 RedisKey 节点）。 */
  public redisKey?: string;
  /** Redis 文件夹前缀（仅 RedisKeyFolder 节点，用于前缀 SCAN）。 */
  public redisKeyPrefix?: string;
  /** B1：PG 命名空间（Schema 节点及其下对象节点携带，用于限定对象名）。 */
  public schema?: string;

  /** 外键关联表（仅 ForeignKey 节点，构造后赋值） */
  public refTable?: string;
  /** 外键关联列（仅 ForeignKey 节点，构造后赋值） */
  public refColumn?: string;
  /** 外键关联表所在 schema（仅 PG ForeignKey 节点，跨 schema 跳转用） */
  public refSchema?: string;
  /** 外键约束名（仅 ForeignKey 节点，DROP FOREIGN KEY 需要） */
  public constraintName?: string;

  /**
   * 向上查找所属 Table 节点，返回表名/库/连接（供 Index/Trigger/FK 等表级子节点命令使用）。
   */
  static tableContext(node: DbTreeNode): { table: string; database?: string; schema?: string; conn?: SavedConnection } | undefined {
    let n: DbTreeNode | undefined = node;
    while (n) {
      if (n.kind === NodeKind.Table) return { table: n.label, database: n.database, schema: n.schema, conn: n.conn };
      n = n.parent;
    }
    return undefined;
  }
}
