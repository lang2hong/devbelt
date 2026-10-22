import * as vscode from 'vscode';
import type { DatabaseType } from '@devbelt/db-core';
import type { SqlScanOptions } from '@devbelt/db-core/sql';
import { l10n } from '../i18n';
import { dialectScanOptions } from '../utils/sqlDialectOptions';
import { lintSql, type LintSeverity } from './sqlLint';

/** Documents larger than this are not linted (keeps typing responsive). */
export const MAX_LINT_CHARS = 200_000;
export const LINT_DEBOUNCE_MS = 300;

export interface SqlDiagnosticsDeps {
  /** Bound connection's database type, if any. */
  resolveDbType: (uri: string) => DatabaseType | undefined;
  /** Scan options of an established session, if any. */
  resolveScanOptions: (uri: string) => SqlScanOptions | undefined;
}

const SEVERITY: Record<LintSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

/**
 * P10 S7：`.sql` 编辑器静态诊断。
 *
 * 只做静态分析，不连接数据库。打开/编辑（防抖）/切换编辑器/改配置时重算，
 * 关闭文档时清除。方言规则只在文档绑定连接时启用。
 */
export class SqlDiagnosticsProvider implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('devbelt-sql');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: SqlDiagnosticsDeps) {
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((doc) => this.refresh(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.clear(doc)),
      vscode.window.onDidChangeActiveTextEditor((editor) => { if (editor) this.refresh(editor.document); }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('devbelt.diagnostics')) this.refreshAll();
      }),
    );
    this.refreshAll();
  }

  /** Re-lint every open SQL document. */
  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) this.refresh(doc);
  }

  refresh(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'sql') return;
    const key = doc.uri.toString();
    this.cancel(key);
    const config = vscode.workspace.getConfiguration('devbelt.diagnostics');
    const text = doc.getText();
    if (config.get<boolean>('enabled', true) === false || text.length > MAX_LINT_CHARS) {
      this.collection.delete(doc.uri);
      return;
    }
    const dbType = this.deps.resolveDbType(key);
    const scanOptions = this.deps.resolveScanOptions(key) ?? dialectScanOptions(dbType);
    const findings = lintSql(text, {
      ...(dbType ? { dbType } : {}),
      scanOptions,
      rules: config.get<Record<string, unknown>>('rules', {}) ?? {},
    });
    this.collection.set(doc.uri, findings.map((f) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(doc.positionAt(f.start), doc.positionAt(f.end)),
        l10n(f.messageKey, f.args),
        SEVERITY[f.severity],
      );
      d.source = 'DevBelt';
      d.code = f.rule;
      return d;
    }));
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const d of this.disposables) d.dispose();
  }

  private schedule(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'sql') return;
    const key = doc.uri.toString();
    this.cancel(key);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.refresh(doc);
    }, LINT_DEBOUNCE_MS));
  }

  private clear(doc: vscode.TextDocument): void {
    this.cancel(doc.uri.toString());
    this.collection.delete(doc.uri);
  }

  private cancel(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
  }
}