import { DatabaseType, ConnectionConfig } from '../types/connection';
import { IConnection } from '../connection/connection';
import { MysqlConnection } from '../connection/mysqlConnection';
import { PostgreSqlConnection } from '../connection/postgreSqlConnection';
import { SqliteConnection } from '../connection/sqliteConnection';
import { DialectRegistry } from '../dialect/dialectRegistry';
import type { SqlDialect } from '../dialect/sqlDialect';

/**
 * 连接工厂（工厂模式）。
 *
 * 根据数据库类型与连接配置创建对应的连接适配器实例，
 * 并同时装配对应的方言策略。调用方无需关心具体连接类型。
 *
 * 新增数据库：实现连接类 + 方言后，在此工厂加一个分支即可。
 */
export class ConnectionFactory {
  /**
   * 创建连接实例。
   * @param dbType 数据库类型
   * @param config 连接配置
   * @returns 连接适配器实例（含方言语义能力）
   */
  static create(dbType: DatabaseType, config: ConnectionConfig): IConnection {
    switch (dbType) {
      case DatabaseType.MYSQL:
        return new MysqlConnection(config);
      case DatabaseType.PG:
        return new PostgreSqlConnection(config);
      case DatabaseType.SQLITE:
        return new SqliteConnection(config, config.sqliteCommand);
      default:
        throw new Error(`Connection not supported for database type: ${dbType}`);
    }
  }

  /**
   * 创建连接实例并显式装配方言。
   * 供查询层使用：连接只负责传输，方言负责生成 SQL 行为。
   */
  static createWithDialect(
    dbType: DatabaseType,
    config: ConnectionConfig,
  ): { connection: IConnection; dialect: SqlDialect } {
    return {
      connection: this.create(dbType, config),
      dialect: DialectRegistry.get(dbType),
    };
  }
}