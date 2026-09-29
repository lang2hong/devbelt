import * as vscode from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { l10n } from '../i18n';

/** PG 连接的默认 schema（未配置时为 public）。 */
export function defaultPgSchema(conn: Pick<SavedConnection, 'schema'>): string {
  return (conn.schema && conn.schema.trim()) || 'public';
}

/** 该（连接, schema）是否属于「非默认 schema」——B1a 阶段禁止写入。 */
export function isNonDefaultSchema(conn: SavedConnection, schema?: string): boolean {
  if (conn.dbType !== DatabaseType.PG || !schema) return false;
  return schema !== defaultPgSchema(conn);
}

/**
 * B1a 写保护：非默认 schema 暂不支持写入/DDL/导出/结构对比（B1b 才做）。
 *
 * 这是**宿主侧断言**（不能只靠菜单隐藏）：PG 非默认 schema 的写操作若按 search_path 执行，
 * 会落到默认 schema 的同名对象上，属静默数据风险。返回 false 表示已提示并应中止。
 */
export function ensureSchemaWritable(conn: SavedConnection, schema?: string): boolean {
  if (!isNonDefaultSchema(conn, schema)) return true;
  vscode.window.showErrorMessage(l10n('pg.schemaWriteLocked', { schema: schema ?? '' }));
  return false;
}