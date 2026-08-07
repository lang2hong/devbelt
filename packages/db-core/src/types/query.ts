import type { FieldInfo } from './meta';

/** 单条查询结果 */
export interface QueryResult {
  sql: string;
  costTime: number;
  rows: any[];
  fields: FieldInfo[];
  /** 受影响行数（DML） */
  affectedRows?: number;
  /** 总行数（分页用） */
  total?: number;
}

/** 查询响应回调 */
export type QueryCallback = (
  err: Error | null,
  results?: any,
  fields?: FieldInfo[],
  total?: number,
) => void;

/** 查询功能签名 */
export interface QueryFunction {
  (sql: string, callback?: QueryCallback): unknown;
  (sql: string, values: any, callback?: QueryCallback): unknown;
}