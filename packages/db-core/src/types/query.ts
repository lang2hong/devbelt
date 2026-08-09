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
  /** Result rows were clipped to the configured client-side limit. */
  truncated?: boolean;
}

/** 查询响应回调 */
export type QueryCallback = (
  err: Error | null,
  results?: any,
  fields?: FieldInfo[],
  total?: number,
) => void;
