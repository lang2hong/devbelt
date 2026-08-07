import { QueryService } from './queryService';
import type { ColumnMeta, TableMeta, ViewMeta } from '../types/meta';

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

  /** 查询表的列元数据 */
  async getColumns(table: string, database?: string): Promise<ColumnMeta[]> {
    const sql = this.queryService.dialect.getColumnsSql(table, database);
    const result = await this.queryService.query(sql);
    return result.rows.map((row: any) => this.normalizeColumn(row));
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