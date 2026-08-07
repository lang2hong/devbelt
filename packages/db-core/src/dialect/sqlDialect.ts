import type { DatabaseType } from '../types/connection';
import type { TableMeta, ViewMeta } from '../types/meta';

/**
 * 方言行为抽象（策略模式）。
 *
 * 每种数据库继承实现本接口，隔离三类差异：
 *  - 标识符包裹规则（如 MySQL 用反引号、PG 用双引号）
 *  - 分页 SQL 生成
 *  - 元数据（库/表/列）查询 SQL
 *
 * 新增数据库只需实现本接口并注册到 DialectRegistry，无需改动上层调用方。
 */
export interface SqlDialect {
  /** 数据库类型标识 */
  readonly dbType: DatabaseType;

  /**
   * 包裹标识符（表名/列名），防止 SQL 注入与关键字冲突。
   * @param identifier 原始标识符
   */
  wrap(identifier: string): string;

  /**
   * 生成分页 SQL。
   * @param sql 原始查询 SQL
   * @param offset 偏移量
   * @param limit 每页行数
   */
  getPagedSql(sql: string, offset: number, limit: number): string;

  /** 查询当前连接下的数据库列表 SQL */
  getDatabaseListSql(): string;

  /** 查询库内所有表（含表注释）的 SQL */
  getTableListSql(database?: string): string;

  /** 查询库内所有视图的 SQL */
  getViewListSql(database?: string): string;

  /** 查询表的列元数据 SQL */
  getColumnsSql(table: string, database?: string): string;

  /** 解析表列表查询结果行为对象 */
  parseTableList(rows: any[]): TableMeta[];

  /** 解析视图列表查询结果行为对象 */
  parseViewList(rows: any[]): ViewMeta[];
}