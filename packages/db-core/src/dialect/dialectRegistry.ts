import { DatabaseType } from '../types/connection.js';
import type { SqlDialect } from './sqlDialect.js';
import { MysqlDialect } from './mysqlDialect.js';
import { PostgreSqlDialect } from './postgreSqlDialect.js';
import { SqliteDialect } from './sqliteDialect.js';

/**
 * 方言注册表（注册表模式）。
 *
 * 集中管理"数据库类型 → 方言实例"的映射。
 * 新增数据库只需在此注册新的方言实现，上层按类型取值即可，
 * 无需改动查询/元数据等调用方代码，满足开闭原则。
 */
export class DialectRegistry {
  private static readonly dialects: Map<DatabaseType, SqlDialect> = new Map();
  /** MySQL 在 NO_BACKSLASH_ESCAPES 下的方言变体（无状态、可共享）。 */
  private static readonly mysqlNoBackslash = new MysqlDialect({ noBackslashEscapes: true });

  /** 注册内置方言（幂等） */
  static register(dialect: SqlDialect): void {
    this.dialects.set(dialect.dbType, dialect);
  }

  /** 获取指定类型的方言，未注册时抛出明确错误 */
  static get(dbType: DatabaseType): SqlDialect {
    const dialect = this.dialects.get(dbType);
    if (!dialect) {
      throw new Error(`Unsupported database type: ${dbType}`);
    }
    return dialect;
  }

  /**
   * 按连接语义取方言：MySQL 且 NO_BACKSLASH_ESCAPES 时返回反斜杠不转义的变体，
   * 其余情况返回共享单例。调用方（连接层）读到 `@@sql_mode` 后据此替换 `QueryService.dialect`。
   */
  static getFor(dbType: DatabaseType, opts: { noBackslashEscapes?: boolean } = {}): SqlDialect {
    if (dbType === DatabaseType.MYSQL && opts.noBackslashEscapes === true) {
      return this.mysqlNoBackslash;
    }
    return this.get(dbType);
  }

  /** 是否已注册 */
  static has(dbType: DatabaseType): boolean {
    return this.dialects.has(dbType);
  }
}

// 模块加载即注册内置方言
DialectRegistry.register(new MysqlDialect());
DialectRegistry.register(new PostgreSqlDialect());
DialectRegistry.register(new SqliteDialect());