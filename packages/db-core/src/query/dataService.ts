import { QueryService } from './queryService';
import type { QueryResult } from '../types/query';

/**
 * 数据编辑服务：基于主键构造 UPDATE 语句更新单元格。
 * 复用查询服务执行，标识符经方言转义，防止注入。
 */
export class DataService {
  constructor(private readonly queryService: QueryService) {}

  /**
   * 更新单行单列。
   * @param table 表名
   * @param primaryKey 主键字段名
   * @param rowId 主键值
   * @param column 待更新列名
   * @param value 新值（null 表示置 NULL）
   */
  async updateCell(
    table: string,
    primaryKey: string,
    rowId: any,
    column: string,
    value: any,
    database?: string,
  ): Promise<QueryResult> {
    const w = this.queryService.dialect.wrap.bind(this.queryService.dialect);
    const qualified = database ? `${w(database)}.${w(table)}` : w(table);
    const setValue = value === null ? 'NULL' : this.literal(value);
    const idLiteral = this.literal(rowId);
    const sql = `UPDATE ${qualified} SET ${w(column)} = ${setValue} WHERE ${w(primaryKey)} = ${idLiteral}`;
    return this.queryService.query(sql);
  }

  /** 将 JS 值转为 SQL 字面量 */
  private literal(v: any): string {
    if (typeof v === 'string') {
      return `'${v.replace(/'/g, "''")}'`;
    }
    if (typeof v === 'boolean') {
      return v ? '1' : '0';
    }
    if (v === undefined) {
      return 'NULL';
    }
    return String(v);
  }
}