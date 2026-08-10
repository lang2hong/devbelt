import * as sqlstring from 'sqlstring';
import { validateIdent } from '../utils/validate';
import { QueryService } from './queryService';
import type { QueryResult } from '../types/query';

/**
 * 数据编辑服务：基于主键构造 UPDATE 语句更新单元格。
 * 标识符经 validateIdent 验证 + 方言包裹，值经 sqlstring.escape 转义。
 */
export class DataService {
  constructor(private readonly queryService: QueryService) {}

  async updateCell(
    table: string,
    primaryKey: string,
    rowId: any,
    column: string,
    value: any,
    database?: string,
  ): Promise<QueryResult> {
    validateIdent(table);
    validateIdent(primaryKey);
    validateIdent(column);
    const w = this.queryService.dialect.wrap.bind(this.queryService.dialect);
    const qualified = database ? `${w(validateIdent(database))}.${w(table)}` : w(table);
    const setValue = value === null ? 'NULL' : sqlstring.escape(value);
    const idLiteral = sqlstring.escape(rowId);
    const sql = `UPDATE ${qualified} SET ${w(column)} = ${setValue} WHERE ${w(primaryKey)} = ${idLiteral}`;
    return this.queryService.query(sql);
  }

  /**
   * 按主键批量删除（单条 DELETE ... IN，原子）。
   * 主键与表名经 validateIdent 校验，值经 sqlstring.escape 转义。
   */
  async deleteRows(
    table: string,
    primaryKey: string,
    rowIds: unknown[],
    database?: string,
  ): Promise<QueryResult> {
    if (!rowIds.length) return this.queryService.query('SELECT 1 WHERE 1 = 0');
    validateIdent(table);
    validateIdent(primaryKey);
    const w = this.queryService.dialect.wrap.bind(this.queryService.dialect);
    const qualified = database ? `${w(validateIdent(database))}.${w(table)}` : w(table);
    const ids = rowIds
      .map((id) => (id === null || id === undefined ? 'NULL' : sqlstring.escape(id)))
      .join(', ');
    const sql = `DELETE FROM ${qualified} WHERE ${w(primaryKey)} IN (${ids})`;
    return this.queryService.query(sql);
  }
}