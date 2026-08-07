import { QueryService } from './queryService';
import type { ColumnMeta, TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta } from '../types/meta';

/**
 * 元数据服务（复用查询服务 + 方言）。
 *
 * 提供库/表/视图/列的元数据查询能力，屏蔽各方言 SQL 差异。
 * 内部通过方言生成 SQL，再通过方言解析结果行。
 */
export class MetadataService {
  constructor(private readonly queryService: QueryService) {}

  /** 查询数据库列表（SQLite 返回空） */
  async getDatabases(): Promise<string[]> {
    const sql = this.queryService.dialect.getDatabaseListSql();
    if (!sql) return [];
    const result = await this.queryService.query(sql);
    return result.rows.map((row: any) => row.name ?? row.Database ?? row.datname);
  }

  /** 查询表列表 */
  async getTables(database?: string): Promise<TableMeta[]> {
    const sql = this.queryService.dialect.getTableListSql(database);
    const result = await this.queryService.query(sql);
    return this.queryService.dialect.parseTableList(result.rows);
  }

  /** 查询视图列表 */
  async getViews(database?: string): Promise<ViewMeta[]> {
    const sql = this.queryService.dialect.getViewListSql(database);
    const result = await this.queryService.query(sql);
    return this.queryService.dialect.parseViewList(result.rows);
  }

  /** 查询函数/存储过程列表 */
  async getFunctions(database?: string): Promise<RoutineMeta[]> {
    const sql = this.queryService.dialect.getFunctionListSql(database);
    if (!sql) return [];
    const result = await this.queryService.query(sql);
    return this.queryService.dialect.parseFunctionList(result.rows);
  }

  /** 查询事件列表 */
  async getEvents(database?: string): Promise<EventMeta[]> {
    const sql = this.queryService.dialect.getEventListSql(database);
    if (!sql) return [];
    const result = await this.queryService.query(sql);
    return this.queryService.dialect.parseEventList(result.rows);
  }

  /** 查询函数/存储过程定义 */
  async getRoutineDefinition(name: string, routineType: string, database?: string): Promise<string> {
    const sql = this.queryService.dialect.getRoutineDefinitionSql(name, routineType, database);
    if (!sql) return '';
    const result = await this.queryService.query(sql);
    const row = result.rows[0];
    if (!row) return '';
    return row['Create Procedure'] || row['Create Function'] || row.definition || row.Create || '';
  }

  /** 查询事件定义 */
  async getEventDefinition(name: string, database?: string): Promise<string> {
    const sql = this.queryService.dialect.getEventDefinitionSql(name, database);
    if (!sql) return '';
    const result = await this.queryService.query(sql);
    const row = result.rows[0];
    if (!row) return '';
    return row['Create Event'] || row.definition || row.Create || '';
  }

  /** 查询表的列元数据 */
  async getColumns(table: string, database?: string): Promise<ColumnMeta[]> {
    const sql = this.queryService.dialect.getColumnsSql(table, database);
    const result = await this.queryService.query(sql);
    return result.rows.map((row: any) => this.normalizeColumn(row));
  }

  /** 查询表索引列表 */
  async getIndexes(table: string, database?: string): Promise<IndexMeta[]> {
    const sql = this.queryService.dialect.getIndexListSql(table, database);
    if (!sql) return [];
    const result = await this.queryService.query(sql);
    return this.queryService.dialect.parseIndexList(result.rows);
  }

  /** 查询用户列表 */
  async getUsers(): Promise<UserMeta[]> {
    const sql = this.queryService.dialect.getUserListSql();
    if (!sql) return [];
    const result = await this.queryService.query(sql);
    return this.queryService.dialect.parseUserList(result.rows);
  }

  /** 查询进程列表（MySQL: SHOW PROCESSLIST, PG: pg_stat_activity） */
  async getProcessList(): Promise<any[]> {
    const dbType = this.queryService.dialect.dbType;
    if (dbType === 'MYSQL') {
      const r = await this.queryService.query('SHOW PROCESSLIST');
      return r.rows;
    }
    if (dbType === 'PG') {
      const r = await this.queryService.query(
        'SELECT pid, usename, datname, client_addr AS host, state, query FROM pg_stat_activity ORDER BY pid',
      );
      return r.rows;
    }
    return [];
  }

  /** 查询状态变量（MySQL only: SHOW STATUS） */
  async getStatusVariables(): Promise<any[]> {
    if (this.queryService.dialect.dbType !== 'MYSQL') return [];
    const r = await this.queryService.query('SHOW GLOBAL STATUS');
    return r.rows;
  }

  /** 查询服务器变量（MySQL: SHOW VARIABLES, PG: pg_settings） */
  async getServerVariables(): Promise<any[]> {
    const dbType = this.queryService.dialect.dbType;
    if (dbType === 'MYSQL') {
      const r = await this.queryService.query('SHOW VARIABLES');
      return r.rows;
    }
    if (dbType === 'PG') {
      const r = await this.queryService.query('SELECT name, setting, short_desc AS description FROM pg_settings ORDER BY name');
      return r.rows;
    }
    return [];
  }

  /** 将各方言列元数据行归一化为统一结构 */
  private normalizeColumn(row: any): ColumnMeta {
    const name = row.name ?? row.Field ?? row.column_name ?? row['name'];
    const type = row.type ?? row.Type ?? row.data_type ?? row['type'];
    const simpleType = row.simple_type ?? row.simpleType ?? String(type).split('(')[0];
    const isPrimary = row.key === 'PRI' || row.Key === 'PRI';
    return {
      name,
      simpleType,
      type,
      comment: row.comment ?? row.Comment ?? row['comment'] ?? '',
      key: row.key ?? row.Key ?? row['key'] ?? '',
      nullable: row.nullable ?? row.Null ?? row.is_nullable ?? '',
      maxLength: row.maxLength ?? '',
      defaultValue: row.defaultValue ?? row.Default ?? row.column_default ?? '',
      extra: row.extra ?? row.Extra ?? '',
      isNotNull: row.isNotNull ?? false,
      isAutoIncrement: false,
      isUnique: false,
      isPrimary,
      pk: isPrimary ? 'PRI' : '',
    };
  }
}