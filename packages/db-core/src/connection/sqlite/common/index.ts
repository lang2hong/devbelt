export type ResultSet = Array<Result>;

export interface Result {
  stmt: string;
  header: string[];
  rows: string[][];
}

export interface ResultNew {
  sql: string;
  fields: { name: string }[];
  rows: object[];
}