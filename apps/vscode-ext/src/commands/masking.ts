import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { DatabaseType } from '@devbelt/db-core';
import { parseMaskingConfig, type MaskingConfig, type TableMaskingConfig } from '@devbelt/masking-core';
import type { Deps, Sub } from './shared';
import { pgSchemaFor } from '../utils/sql';
import { l10n } from '../i18n';
import { getProjectSalt } from '../masking/salt';
import { exportMaskedTable, readMaskedRows, type MaskedExportDeps } from '../masking/export';
import { collectMaskedSubset, writeSubsetSql, type SubsetExportDeps } from '../masking/subset';

function safeStem(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'table';
}

async function readConfig(table: string): Promise<{ ok: true; table: TableMaskingConfig; config: MaskingConfig } | { ok: false; message: string }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return { ok: false, message: l10n('masking.noWorkspace') };
  const rel = vscode.workspace.getConfiguration('devbelt').get<string>('masking.configPath', '.devbelt-mask.json');
  const file = path.isAbsolute(rel) ? rel : path.join(folders[0]!.uri.fsPath, rel);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { ok: false, message: l10n('masking.configMissing', { file }) };
  }
  const parsed = parseMaskingConfig(raw);
  if (!parsed.ok) return { ok: false, message: l10n('masking.configInvalid', { errors: parsed.errors.join('; ') }) };
  return { ok: true, table: parsed.config.tables[table] ?? {}, config: parsed.config };
}

export function registerMaskingCommands(deps: Deps, sub: Sub): void {
  sub('devbelt.exportMasked', async (node: any) => {
    if (!node?.conn || !node.database) return;
    const conn = node.conn;
    const database: string = node.database;
    const table: string = node.label;
    const schema = conn.dbType === DatabaseType.PG ? pgSchemaFor(conn, node.schema) : undefined;
    const config = await readConfig(table);
    if (!config.ok) {
      void vscode.window.showErrorMessage(config.message);
      return;
    }
    const entry = config.table;
    if (!entry.columns || Object.keys(entry.columns).length === 0) {
      void vscode.window.showErrorMessage(l10n('masking.tableMissing', { table }));
      return;
    }

    const opened = await deps.manager.openIsolatedSql(conn, database);
    try {
      if (schema) {
        await opened.session.query.query(
          `SET search_path TO ${opened.session.query.wrap(schema)}, public`,
          undefined,
          { skipHistory: true },
        );
      }
      const salt = await getProjectSalt(deps.context.secrets, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
      const exportDeps: MaskedExportDeps = {
        query: opened.session.query,
        dialect: opened.session.query.dialect,
        metadata: opened.session.metadata,
        table,
        ...(database ? { database } : {}),
        ...(schema ? { schema } : {}),
        ...(entry.where ? { where: entry.where } : {}),
        columns: entry.columns,
        ...(entry.allowUnmasked ? { allowUnmasked: entry.allowUnmasked } : {}),
        salt,
        maxRows: 100_000,
      };

      const subset = entry.referenced === true || entry.referencing === true;
      if (subset) {
        const subsetDeps: SubsetExportDeps = {
          query: opened.session.query,
          dialect: opened.session.query.dialect,
          metadata: opened.session.metadata,
          ...(database ? { database } : {}),
          ...(schema ? { schema } : {}),
          config: config.config,
          salt,
          rootTable: table,
        };
        const result = await collectMaskedSubset(subsetDeps);
        const summary = result.tables.map((t) => `${t.name} (${t.rows.length})`).join(', ');
        const proceed = await vscode.window.showWarningMessage(
          l10n('masking.subsetConfirm'),
          { modal: true, detail: l10n('masking.subsetDetail', { tables: summary, rows: String(result.rows) }) },
          l10n('masking.run'),
        );
        if (proceed !== l10n('masking.run')) return;
        const base = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uri = await vscode.window.showSaveDialog({
          defaultUri: base
            ? vscode.Uri.joinPath(base, `${safeStem(table)}-subset-masked.sql`)
            : vscode.Uri.file(`${safeStem(table)}-subset-masked.sql`),
          filters: { SQL: ['sql'] },
        });
        if (!uri) return;
        await writeSubsetSql(subsetDeps, result, uri.fsPath);
        void vscode.window.showInformationMessage(l10n('masking.done', { rows: String(result.rows), file: uri.fsPath }));
        return;
      }

      const preview = await readMaskedRows(exportDeps, 20);
      const previewText = [
        preview.columns.map((c) => c.name).join(','),
        ...preview.rows.map((row) => preview.columns.map((c) => JSON.stringify(row[c.name] ?? null)).join(',')),
      ].join('\n');
      const doc = await vscode.workspace.openTextDocument({ content: previewText, language: 'csv' });
      await vscode.window.showTextDocument(doc, { preview: true });
      const proceed = await vscode.window.showWarningMessage(
        l10n('masking.confirm'),
        { modal: true, detail: l10n('masking.confirmDetail', { table, rows: String(preview.rows.length) }) },
        l10n('masking.run'),
      );
      if (proceed !== l10n('masking.run')) return;

      const base = vscode.workspace.workspaceFolders?.[0]?.uri;
      const uri = await vscode.window.showSaveDialog({
        defaultUri: base
          ? vscode.Uri.joinPath(base, `${safeStem(table)}-masked.csv`)
          : vscode.Uri.file(`${safeStem(table)}-masked.csv`),
        filters: { CSV: ['csv'], SQL: ['sql'] },
      });
      if (!uri) return;
      const format = uri.fsPath.toLowerCase().endsWith('.sql') ? 'sql' : 'csv';
      const result = await exportMaskedTable(exportDeps, format, uri.fsPath, 100_000);
      void vscode.window.showInformationMessage(l10n('masking.done', { rows: String(result.rows), file: uri.fsPath }));
    } catch (err) {
      void vscode.window.showErrorMessage(l10n('masking.failed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      opened.close();
    }
  });
}