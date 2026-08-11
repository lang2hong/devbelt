import { QueryService } from './queryService';
import { normalizeColumnMeta } from './normalize';
import type { ColumnMeta, TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta } from '../types/meta';

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

  /** 查询视图定义 */
  async getViewDefinition(name: string, database?: string): Promise<string> {
    const sql = this.queryService.dialect.getViewDefinitionSql(name, database);
    if (!sql) return '';
    const result = await this.queryService.query(sql);
    const row = result.rows[0];
    if (!row) return '';
    return row['Create View'] || row.definition || row.sql || row.Create || '';
  }

  /** 查询表的列元数据 */
  async getColumns(table: string, database?: string): Promise<ColumnMeta[]> {
    const sql = this.queryService.dialect.getColumnsSql(table, database);
    const result = await this.queryService.query(sql);
    return result.rows.map((row: any) => normalizeColumnMeta(row));
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

  async getProcessList(): Promise<any[]> {
    const sql = this.queryService.dialect.getProcessListSql();
    if (!sql) return [];
    const r = await this.queryService.query(sql);
    return r.rows;
  }

  async getStatusVariables(): Promise<any[]> {
    const sql = this.queryService.dialect.getStatusVariablesSql();
    if (!sql) return [];
    const r = await this.queryService.query(sql);
    return r.rows;
  }

  async getServerVariables(): Promise<any[]> {
    const sql = this.queryService.dialect.getServerVariablesSql();
    if (!sql) return [];
    const r = await this.queryService.query(sql);
    return r.rows;
  }

  /** 查询外键关系 */
  async getForeignKeys(database?: string): Promise<ForeignKeyMeta[]> {
    const sql = this.queryService.dialect.getForeignKeysSql(database);
    if (!sql) return [];
    const result = await this.queryService.query(sql);
    return this.queryService.dialect.parseForeignKeys(result.rows);
  }
}