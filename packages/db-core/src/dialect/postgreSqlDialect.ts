import { DatabaseType } from '../types/connection';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta } from '../types/meta';
import type { SqlDialect } from './sqlDialect';

/**
 * PostgreSQL 方言实现。
 */
export class PostgreSqlDialect implements SqlDialect {
  readonly dbType = DatabaseType.PG;

  wrap(identifier: string): string {
    return `"${identifier}"`;
  }

  getPagedSql(sql: string, offset: number, limit: number): string {
    return `${sql} LIMIT ${limit} OFFSET ${offset}`;
  }

  getDatabaseListSql(): string {
    return `SELECT datname AS name FROM pg_database WHERE datistemplate = false AND datallowconn = true`;
  }

  getTableListSql(): string {
    return `SELECT c.relname AS name, obj_description(c.oid) AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = current_schema()
      ORDER BY c.relname`;
  }

  getViewListSql(): string {
    return `SELECT c.relname AS name, obj_description(c.oid) AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'v' AND n.nspname = current_schema()
      ORDER BY c.relname`;
  }

  getFunctionListSql(): string {
    return `SELECT p.proname AS name,
        CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'f' THEN 'FUNCTION' ELSE 'FUNCTION' END AS type
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema()
      ORDER BY p.proname`;
  }

  getEventListSql(): string {
    return '';
  }

  getRoutineDefinitionSql(name: string, _routineType: string): string {
    return `SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = '${name}' AND n.nspname = current_schema()`;
  }

  getEventDefinitionSql(): string {
    return '';
  }

  getIndexListSql(table: string): string {
    return `SELECT indexname AS name, indexdef AS definition, 
      CASE WHEN indexdef LIKE '%UNIQUE%' THEN true ELSE false END AS is_unique,
      CASE WHEN indexname = '${table}_pkey' THEN true ELSE false END AS is_primary
      FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = '${table}'`;
  }

  getColumnsSql(table: string): string {
    return `SELECT column_name AS name,
        data_type AS simple_type,
        data_type AS type,
        COALESCE(column_default, '') AS default_value,
        is_nullable AS nullable,
        '' AS comment,
        '' AS key
      FROM information_schema.columns
      WHERE table_name = '${table}' AND table_schema = current_schema()
      ORDER BY ordinal_position`;
  }

  parseTableList(rows: any[]): TableMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
  }

  parseViewList(rows: any[]): ViewMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
  }

  parseFunctionList(rows: any[]): RoutineMeta[] {
    return rows.map((row) => ({
      name: row.name,
      type: row.type || 'FUNCTION',
      comment: '',
    }));
  }

  parseEventList(): EventMeta[] {
    return [];
  }

  parseIndexList(rows: any[]): IndexMeta[] {
    return rows.map((row) => ({
      name: row.name,
      columns: [],
      isUnique: row.is_unique || false,
      isPrimary: row.is_primary || false,
      type: row.definition || '',
    }));
  }
}