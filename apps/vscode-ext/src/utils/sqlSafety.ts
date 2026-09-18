import * as vscode from 'vscode';
import type { SavedConnection } from '@devkit/db-host/connection/connectionStore';
import { l10n } from '../i18n';
import { analyzeSqlRisk } from './sqlRisk';
import { dialectScanOptions } from './sqlDialectOptions';

export { analyzeSqlRisk } from './sqlRisk';
export type { SqlRisk, SqlRiskLevel } from './sqlRisk';

/**
 * 只读连接拦截。
 *
 * 独立于 `confirmSqlExecution` 暴露，供那些**故意不弹确认框**的交互式 DDL 使用
 * （表设计器、字段/索引右键命令）。去掉确认提示是产品决定，但只读连接是能力
 * 边界而非提示，必须单独守住 —— 否则「少一个弹窗」会变成「少一道保护」。
 *
 * @returns 可写返回 true；只读则提示并返回 false。
 */
export function ensureWritable(conn: SavedConnection): boolean {
  if (!conn.readOnly) return true;
  vscode.window.showErrorMessage(l10n('conn.readOnlyBlocked', { name: conn.name || conn.host }));
  return false;
}

/**
 * Enforces read-only mode and asks for explicit confirmation for destructive
 * statements or any production write. This is intentionally local so every
 * provider, including future AI providers, shares the same guardrail.
 */
export async function confirmSqlExecution(conn: SavedConnection, sql: string): Promise<boolean> {
  const risk = analyzeSqlRisk(sql, dialectScanOptions(conn.dbType));
  if (!risk.isWrite) return true;
  if (!ensureWritable(conn)) return false;
  if (risk.level !== 'critical' && conn.environment !== 'production') return true;

  const detail = risk.reason || 'Write statement on a production connection';
  const action = 'Run SQL';
  return (await vscode.window.showWarningMessage(
    `${detail}. Review the SQL before continuing.`,
    { modal: true },
    action,
  )) === action;
}
