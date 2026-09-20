import type { DatabaseType } from '../types/connection.js';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta, TriggerMeta } from '../types/meta.js';
import type { DatabaseCapabilities } from './capabilities.js';

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
   * 会话是否处于 MySQL `NO_BACKSLASH_ESCAPES`（仅 MySQL 相关）。
   * 供切分/值转义按连接语义派生选项；其它方言不实现（视为 false）。
   */
  readonly noBackslashEscapes?: boolean;
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
   * 新增列语句模板（新建列 SQL 入口的初始语句）。
   *
   * 与建表模板同源：列类型候选因方言而异，命令层不硬编码类型。
   *
   * @param table 已包裹好的表标识符
   */
  addColumnTemplate(table: string): string;

  /**
   * 修改列语句模板（改列 SQL 入口的初始语句）。
   *
   * MySQL 用 `MODIFY COLUMN`（改名走独立的 RENAME COLUMN 入口）；
   * PG 用 `ALTER COLUMN ... TYPE`；SQLite 不支持改列型，只能改名。
   *
   * @param table 已包裹好的表标识符
   * @param column 未包裹的列名（由实现按需包裹）
   * @param definition 预填的列定义/类型（MySQL 为完整定义）
   */
  modifyColumnTemplate(table: string, column: string, definition: string): string;

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

  /**
   * keyset 分页：按 `orderColumns` 排序，取严格大于上一页末行 `afterValues` 的下一批。
   * `afterValues` 省略即首页。相比 OFFSET，深分页不随页数线性变慢。
   *
   * - `baseSql` 必须是「列选择 + FROM（可含 JOIN）」的基本 SELECT，**不得**自带
   *   WHERE / GROUP BY / ORDER BY / LIMIT（本方法会追加这些子句）。
   * - `orderColumns` 必须唯一且非空（通常用主键）；`afterValues` 长度须与其一致。
   * - `limit` 必须为正整数。
   * - 比较采用展开式而非行值构造器，兼容 MySQL 复合主键（MySQL 不支持 `(a,b) > (...)`）。
   */
  getKeysetSql(baseSql: string, orderColumns: string[], afterValues: unknown[] | undefined, limit: number): string;

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

  /**
   * 把原始视图定义规范化为「可编辑可执行」的修改语句。
   *
   * `getViewDefinitionSql` 返回的是库里的原始 DDL（MySQL 的 SHOW CREATE VIEW
   * 带 `ALGORITHM/DEFINER/SQL SECURITY` 头且是 `CREATE VIEW`，重跑会因已存在报错；
   * PG 的 `pg_get_viewdef` 只返回纯 SELECT；SQLite 是 `CREATE VIEW`）。
   * 这里统一成 `CREATE OR REPLACE VIEW <name> AS <select>`（SQLite 不支持
   * OR REPLACE，用 `DROP VIEW IF EXISTS` + `CREATE VIEW`），交给编辑器让用户改完
   * 直接执行重建视图。
   */
  normalizeViewAlterSql(raw: string, name: string, database?: string): string;

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

  /**
   * 查询当前用户标识 SQL（降级用）。
   *
   * 受限账号（云数据库、非 DBA）无权 SELECT `mysql.user` / `pg_user`，
   * `getUsers()` 全量查询会失败。此时降级到「当前用户」，至少让用户管理面板
   * 能打开、能对自己改密码。可选：不实现则降级返回空。
   */
  getCurrentUserSql?(): string;

  /**
   * 查询指定用户已有权限 SQL（空字符串/不实现表示不支持）。
   *
   * 用户管理面板选中用户时回显其已有权限（默认勾选），而不是每次都空白。
   * MySQL 用 `SHOW GRANTS FOR`；PG 角色权限查询复杂，第一版不实现（返回空）。
   */
  getUserGrantsSql?(name: string, host?: string, database?: string): string;

  /**
   * 解析权限查询结果为白名单权限字符串列表。
   * 调用方拿到的列表直接用于多选回显，故应去重并跳过 `USAGE`（无权限占位）。
   */
  parseGrants?(rows: any[], database?: string): string[];

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
