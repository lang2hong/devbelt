import type { DatabaseType } from '../types/connection';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta, TriggerMeta } from '../types/meta';
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
   * 本方言的列类型候选（表设计器类型下拉用）。
   * 由方言提供而非 UI 硬编码，避免把 MySQL 类型集合套给 PG/SQLite。
   */
  readonly columnTypes: readonly string[];

  /**
   * 建表语句模板（新建表命令的初始 SQL）。
   *
   * 由方言提供而非命令层硬编码：自增主键的写法三家完全不同
   * （MySQL `AUTO_INCREMENT`、PG `SERIAL`、SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`），
   * 过去统一发 MySQL 语法，PG/SQLite 用户拿到的模板直接执行会报错。
   *
   * @param table 已包裹好的表标识符
   */
  createTableTemplate(table: string): string;

  /**
   * 存储过程/函数模板；本方言不支持例程时返回空字符串。
   *
   * MySQL 需要 `DELIMITER` 包裹（那是客户端命令，PG 不认），
   * PG 用 `CREATE FUNCTION ... $$ ... $$ LANGUAGE plpgsql`。
   *
   * @param name 例程名（未包裹，由实现按需处理）
   */
  createRoutineTemplate(name: string): string;

  /**
   * 包裹标识符（表名/列名），防止 SQL 注入与关键字冲突。
   * @param identifier 原始标识符
   */
  wrap(identifier: string): string;

  /**
   * 将值转为本方言合法的 SQL 字面量（含外层引号）。
   *
   * 各方言字符串转义规则不同，必须由方言决定，不能统一用某一家的规则：
   *  - MySQL 默认开启反斜杠转义，`\` 与 `'` 均需处理
   *  - PostgreSQL 默认 `standard_conforming_strings=on`，`\` 无转义语义，
   *    若按 MySQL 规则写出 `\'` 会提前闭合字符串，形成注入点
   *  - SQLite 同 PostgreSQL，仅单引号翻倍
   *
   * @param value 任意值（null/undefined → NULL）
   */
  escapeValue(value: any): string;

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

  /** 查询视图定义的 SQL（空字符串表示不支持） */
  getViewDefinitionSql(name: string, database?: string): string;

  /** 查询表索引列表 SQL */
  getIndexListSql(table: string, database?: string): string;

  /** 查询表触发器列表 SQL（空字符串表示不支持） */
  getTriggerListSql(table: string, database?: string): string;

  /** 查询触发器定义 SQL（空字符串表示不支持） */
  getTriggerDefinitionSql(name: string, database?: string): string;

  /** 生成创建索引 SQL */
  createIndexSql(name: string, table: string, columns: string[], unique: boolean, database?: string): string;

  /** 生成删除索引 SQL */
  dropIndexSql(name: string, table: string, database?: string): string;

  /** 生成删除触发器 SQL */
  dropTriggerSql(name: string, table: string, database?: string): string;

  /** 生成创建外键 SQL（空字符串表示不支持） */
  createForeignKeySql(name: string, table: string, columns: string[], refTable: string, refColumns: string[], database?: string): string;

  /** 生成删除外键 SQL（空字符串表示不支持） */
  dropForeignKeySql(name: string, table: string, database?: string): string;

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

  /** 解析触发器列表查询结果 */
  parseTriggerList(rows: any[]): TriggerMeta[];

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
