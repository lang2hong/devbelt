import type { DatabaseType } from '../types/connection';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta } from '../types/meta';
import type { DatabaseCapabilities } from './capabilities';

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
  /** Explicitly declared database and object-management capabilities. */
  readonly capabilities: DatabaseCapabilities;

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

  /** 查询库内所有函数/存储过程的 SQL（空字符串表示不支持） */
  getFunctionListSql(database?: string): string;

  /** 查询库内所有事件的 SQL（空字符串表示不支持） */
  getEventListSql(database?: string): string;

  /** 查询函数/存储过程定义的 SQL */
  getRoutineDefinitionSql(name: string, routineType: string, database?: string): string;

  /** 查询事件定义的 SQL */
  getEventDefinitionSql(name: string, database?: string): string;

  /** 查询表索引列表 SQL */
  getIndexListSql(table: string, database?: string): string;

  /** 查询用户列表 SQL（空字符串表示不支持） */
  getUserListSql(): string;

  /** 查询外键关系 SQL（空字符串表示不支持） */
  getForeignKeysSql(database?: string): string;

  /** 查询表的列元数据 SQL */
  getColumnsSql(table: string, database?: string): string;

  /** 查询进程列表 SQL（空字符串表示不支持） */
  getProcessListSql(): string;

  /** 查询状态变量 SQL（空字符串表示不支持） */
  getStatusVariablesSql(): string;

  /** 查询服务器变量 SQL（空字符串表示不支持） */
  getServerVariablesSql(): string;

  /** 解析表列表查询结果行为对象 */
  parseTableList(rows: any[]): TableMeta[];

  /** 解析视图列表查询结果行为对象 */
  parseViewList(rows: any[]): ViewMeta[];

  /** 解析函数列表查询结果 */
  parseFunctionList(rows: any[]): RoutineMeta[];

  /** 解析事件列表查询结果 */
  parseEventList(rows: any[]): EventMeta[];

  /** 解析索引列表查询结果 */
  parseIndexList(rows: any[]): IndexMeta[];

  /** 解析用户列表查询结果 */
  parseUserList(rows: any[]): UserMeta[];

  /** 解析外键关系查询结果 */
  parseForeignKeys(rows: any[]): ForeignKeyMeta[];

  /**
   * 生成本方言正确的 INSERT 语句（用于数据导出）。
   * 标识符包裹与 schema/database 限定由各方言自行决定。
   * @param rows 数据行
   * @param columns 要导出的列名
   * @param table 目标表
   * @param database 数据库/schema 限定（当且仅当该方言支持时才前置）
   */
  buildInsertSql(rows: Record<string, any>[], columns: string[], table: string, database?: string): string;
}
