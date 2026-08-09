import * as vscode from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';
import { analyzeSqlRisk } from './sqlRisk';

export { analyzeSqlRisk } from './sqlRisk';
export type { SqlRisk, SqlRiskLevel } from './sqlRisk';

/**
 * Enforces read-only mode and asks for explicit confirmation for destructive
 * statements or any production write. This is intentionally local so every
 * provider, including future AI providers, shares the same guardrail.
 */
export async function confirmSqlExecution(conn: SavedConnection, sql: string): Promise<boolean> {
  const risk = analyzeSqlRisk(sql);
  if (!risk.isWrite) return true;
  if (conn.readOnly) {
    vscode.window.showErrorMessage(`Connection "${conn.name || conn.host}" is read-only.`);
    return false;
  }
  if (risk.level !== 'critical' && conn.environment !== 'production') return true;

  const detail = risk.reason || 'Write statement on a production connection';
  const action = 'Run SQL';
  return (await vscode.window.showWarningMessage(
    `${detail}. Review the SQL before continuing.`,
    { modal: true },
    action,
  )) === action;
}
