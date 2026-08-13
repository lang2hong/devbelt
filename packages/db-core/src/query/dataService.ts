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
    pkColumns: string[],
    pkValues: any[],
    column: string,
    value: any,
    database?: string,
  ): Promise<QueryResult> {
    if (!pkColumns.length) throw new Error('updateCell requires at least one primary key column.');
    validateIdent(table);
    for (const pk of pkColumns) validateIdent(pk);
    validateIdent(column);
    const w = this.queryService.dialect.wrap.bind(this.queryService.dialect);
    const qualified = database ? `${w(validateIdent(database))}.${w(table)}` : w(table);
    const setValue = value === null ? 'NULL' : sqlstring.escape(value);
    const where = pkColumns
      .map((pk, i) => {
        const v = pkValues[i];
        return v === null || v === undefined ? `${w(pk)} IS NULL` : `${w(pk)} = ${sqlstring.escape(v)}`;
      })
      .join(' AND ');
    const sql = `UPDATE ${qualified} SET ${w(column)} = ${setValue} WHERE ${where}`;
    return this.queryService.query(sql);
  }

  /**
   * 按主键批量删除（每行 AND 条件，多行 OR 连接，原子单语句）。
   * 复合主键退化为单列时等价于 IN。值经 sqlstring.escape 转义。
   */
  async deleteRows(
    table: string,
    pkColumns: string[],
    rows: any[][],
    database?: string,
  ): Promise<QueryResult> {
    if (!rows.length) return this.queryService.query('SELECT 1 WHERE 1 = 0');
    validateIdent(table);
    for (const pk of pkColumns) validateIdent(pk);
    const w = this.queryService.dialect.wrap.bind(this.queryService.dialect);
    const qualified = database ? `${w(validateIdent(database))}.${w(table)}` : w(table);
    const where = rows
      .map(
        (row) =>
          `(${pkColumns
            .map((pk, i) => {
              const v = row[i];
              return v === null || v === undefined ? `${w(pk)} IS NULL` : `${w(pk)} = ${sqlstring.escape(v)}`;
            })
            .join(' AND ')})`,
      )
      .join(' OR ');
    const sql = `DELETE FROM ${qualified} WHERE ${where}`;
    return this.queryService.query(sql);
  }

  /**
   * 插入一行。列名经 validateIdent 校验，值经 sqlstring.escape 转义。
   * @param columns 列名数组（与 values 对齐）
   * @param values 各列值（null/undefined 写成 NULL）
   */
  async insertRow(
    table: string,
    columns: string[],
    values: unknown[],
    database?: string,
  ): Promise<QueryResult> {
    if (!columns.length) throw new Error('At least one column is required to insert a row.');
    validateIdent(table);
    const w = this.queryService.dialect.wrap.bind(this.queryService.dialect);
    const qualified = database ? `${w(validateIdent(database))}.${w(table)}` : w(table);
    const cols = columns.map((c) => w(validateIdent(c))).join(', ');
    const vals = (columns.length ? values : []).map((v) =>
      v === null || v === undefined ? 'NULL' : sqlstring.escape(v),
    ).join(', ');
    const sql = `INSERT INTO ${qualified} (${cols}) VALUES (${vals})`;
    return this.queryService.query(sql);
  }
}