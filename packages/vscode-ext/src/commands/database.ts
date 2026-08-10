import * as vscode from 'vscode';
import { SchemaDiffService } from '@db-client/core';
import { DbTreeNode } from '../tree/dbTreeNode';
import { wrapIdent, splitSqlStatements } from '../utils/sql';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { parseCsv } from '../data/transfer/csv';
import { parseJson } from '../data/transfer/json';
import { autoMapFields, type FieldMapping } from '../data/transfer/fieldMapper';
import { exportTable, TransferCancelledError, type TransferFormat } from '../data/transfer/exportService';
import { importRows } from '../data/transfer/importService';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm, openSqlDoc, requireCapability } from './shared';

export function registerDatabaseCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider, connCtx } = deps;

  sub('dbclient.createDatabase', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('db.createPrompt') });
    if (!name) return;
    connCtx.setLast(node.conn);
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'createDatabase')) return;
    await session.query.query(`CREATE DATABASE ${wrapIdent(node.conn, name)}`);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('db.created', { name }));
  });

  sub('dbclient.dropDatabase', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!(await confirm('db.dropConfirm', 'db.drop', node.label))) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'dropDatabase')) return;
    await session.query.query(`DROP DATABASE ${wrapIdent(node.conn, node.label)}`);
    manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  sub('dbclient.importData', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const format = await pickFormat('import');
    if (!format) return;
    const uri = await vscode.window.showOpenDialog({
      filters: importFilters(format),
      canSelectMany: false,
      openLabel: l10n('import.selectFile'),
    });
    if (!uri?.[0]) return;
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri[0])).toString('utf8');
    if (format === 'sql') {
      await importSqlScript(node, text, manager, treeProvider, connCtx);
      return;
    }
    await importStructuredData(node, format, text, manager, treeProvider, connCtx);
  });

  sub('dbclient.exportConnection', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    await runExportWizard(node, manager, connCtx);
  });

  sub('dbclient.compareSchema', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    if (!requireCapability(session, 'schemaSync')) return;
    const targetDbs = (await session.metadata.getDatabases()).filter((d) => d !== node.database);
    if (!targetDbs.length) {
      vscode.window.showWarningMessage('No other databases to compare.');
      return;
    }
    const target = await vscode.window.showQuickPick(
      targetDbs.map((d) => ({ label: d, value: d })),
      { placeHolder: `Compare "${node.database}" with which database?` },
    );
    if (!target) return;

    const diffs = await SchemaDiffService.diff(session.metadata, node.database, session.metadata, target.value);
    const syncSql = await SchemaDiffService.generateSyncSql(diffs, target.value, session.table, node.database);
    const added = diffs.filter((d) => d.status === 'added').length;
    const removed = diffs.filter((d) => d.status === 'removed').length;
    const changed = diffs.filter((d) => d.status === 'changed').length;
    const header = `-- Diff: ${node.database} -> ${target.value} (${added} added, ${removed} removed, ${changed} changed)\n\n`;
    await openSqlDoc(header + syncSql);
  });
}

export async function runExportWizard(
  node: DbTreeNode,
  manager: Deps['manager'],
  connCtx: Deps['connCtx'],
  fixedTable?: string,
): Promise<void> {
  if (!node.conn) return;
  const format = await pickFormat('export');
  if (!format) return;
  const session = await manager.connect(node.conn);
  if (!requireCapability(session, 'dumpTable')) return;
  const database = await pickExportDatabase(node, session.metadata.getDatabases.bind(session.metadata));
  if (database === undefined && node.conn.dbType === 'MYSQL' && !node.database) return;
  const tables = fixedTable ? [fixedTable] : await pickTables(session.metadata.getTables.bind(session.metadata), database);
  if (!tables?.length) return;
  const exportContents = format === 'sql'
    ? (await vscode.window.showQuickPick(
      [
        { label: l10n('export.structureOnly'), value: { includeStructure: true, includeData: false } },
        { label: l10n('export.structureData'), value: { includeStructure: true, includeData: true } },
        { label: l10n('export.dataOnly'), value: { includeStructure: false, includeData: true } },
      ],
      { placeHolder: l10n('export.choose') },
    ))?.value
    : { includeStructure: false, includeData: true };
  if (!exportContents) return;
  const extension = format;
  const destination = tables.length === 1
    ? await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${tables[0]}.${extension}`), filters: exportFilters(format) })
    : (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: l10n('export.selectFolder') }))?.[0];
  if (!destination) return;
  connCtx.setLast(node.conn, database);
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: l10n('export.progress'),
      cancellable: true,
    }, async (progress, token) => {
      for (let index = 0; index < tables.length; index++) {
        const table = tables[index];
        progress.report({ message: `${table} (${index + 1}/${tables.length})` });
        const content = await exportTable({
          source: { query: session.query, metadata: session.metadata, table: session.table },
          format,
          table,
          database,
          includeStructure: exportContents.includeStructure,
          includeData: exportContents.includeData,
          isCancelled: () => token.isCancellationRequested,
          onProgress: ({ rows }) => progress.report({ message: `${table}: ${rows} row(s)` }),
        });
        const target = tables.length === 1 ? destination : vscode.Uri.joinPath(destination, `${table}.${extension}`);
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
      }
    });
    vscode.window.showInformationMessage(l10n('export.done', { count: tables.length }));
  } catch (error) {
    if (error instanceof TransferCancelledError) {
      vscode.window.showInformationMessage(l10n('transfer.cancelled'));
    } else {
      vscode.window.showErrorMessage(l10n('export.failed', { message: (error as Error).message }));
    }
  }
}

async function importSqlScript(
  node: DbTreeNode,
  sql: string,
  manager: Deps['manager'],
  treeProvider: Deps['treeProvider'],
  connCtx: Deps['connCtx'],
): Promise<void> {
  if (!(await confirmSqlExecution(node.conn!, sql))) return;
  const session = await manager.connect(node.conn!);
  const database = node.database;
  connCtx.setLast(node.conn!, database);
  if (database) {
    try { await session.query.query(`USE ${wrapIdent(node.conn!, database)}`); } catch { /* PostgreSQL/SQLite do not support USE. */ }
  }
  const statements = splitSqlStatements(sql);
  let done = 0;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n('import.progress'), cancellable: true }, async (progress, token) => {
      for (const statement of statements) {
        if (token.isCancellationRequested) throw new TransferCancelledError();
        await session.query.query(statement);
        done++;
        progress.report({ message: `${done}/${statements.length}` });
      }
    });
    vscode.window.showInformationMessage(l10n('import.done', { count: done }));
    treeProvider.refresh();
  } catch (error) {
    if (error instanceof TransferCancelledError) vscode.window.showInformationMessage(l10n('transfer.cancelled'));
    else vscode.window.showErrorMessage(l10n('import.failedStatement', { count: done, message: (error as Error).message }));
  }
}

async function importStructuredData(
  node: DbTreeNode,
  format: Exclude<TransferFormat, 'sql'>,
  text: string,
  manager: Deps['manager'],
  treeProvider: Deps['treeProvider'],
  connCtx: Deps['connCtx'],
): Promise<void> {
  let source: { columns: string[]; rows: Record<string, unknown>[] };
  try {
    if (format === 'csv') {
      const header = await vscode.window.showQuickPick(
        [{ label: l10n('import.firstRowHeader'), value: true }, { label: l10n('import.noHeader'), value: false }],
        { placeHolder: l10n('import.headerChoice') },
      );
      if (!header) return;
      source = parseCsv(text, header.value);
    } else {
      source = parseJson(text);
    }
  } catch (error) {
    vscode.window.showErrorMessage(l10n('import.parseFailed', { message: (error as Error).message }));
    return;
  }
  if (!source.rows.length) {
    vscode.window.showWarningMessage(l10n('import.noRows'));
    return;
  }
  const session = await manager.connect(node.conn!);
  const database = await pickImportDatabase(node, session.metadata.getDatabases.bind(session.metadata));
  if (database === undefined && node.conn!.dbType === 'MYSQL' && !node.database) return;
  const tables = await session.metadata.getTables(database);
  const table = await vscode.window.showQuickPick(tables.map((item) => ({ label: item.name })), { placeHolder: l10n('import.selectTable') });
  if (!table) return;
  const mappings = await configureMappings(source.columns, (await session.metadata.getColumns(table.label, database)).map((column) => column.name));
  if (!mappings) return;
  const selected = mappings.filter((mapping) => mapping.target);
  const preview = l10n('import.preview', { rows: source.rows.length, fields: selected.map((mapping) => `${mapping.source} -> ${mapping.target}`).join(', ') });
  const run = await vscode.window.showWarningMessage(preview, { modal: true }, l10n('import.run'));
  if (run !== l10n('import.run')) return;
  const insertPreview = session.query.dialect.buildInsertSql([{ [selected[0].target!]: source.rows[0][selected[0].source] }], [selected[0].target!], table.label, database);
  if (!(await confirmSqlExecution(node.conn!, insertPreview))) return;
  connCtx.setLast(node.conn!, database);
  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n('import.progress'), cancellable: true }, (progress, token) => importRows({
      query: session.query,
      table: table.label,
      database,
      rows: source.rows,
      mappings,
      isCancelled: () => token.isCancellationRequested,
      onProgress: ({ completed, total }) => progress.report({ message: `${completed}/${total}`, increment: total ? 100 / total : 0 }),
    }));
    if (result.errors.length) {
      await showImportReport(result.errors[0].row, result.errors[0].message);
      vscode.window.showErrorMessage(l10n('import.rolledBack', { row: result.errors[0].row }));
      return;
    }
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('import.rowsDone', { count: result.imported }));
  } catch (error) {
    if (error instanceof TransferCancelledError) vscode.window.showInformationMessage(l10n('transfer.cancelled'));
    else vscode.window.showErrorMessage(l10n('import.failed', { message: (error as Error).message }));
  }
}

async function configureMappings(sourceColumns: string[], targetColumns: string[]): Promise<FieldMapping[] | undefined> {
  const mappings = autoMapFields(sourceColumns, targetColumns);
  for (const mapping of mappings) {
    const used = new Set(mappings.filter((item) => item !== mapping).map((item) => item.target).filter(Boolean));
    const choice = await vscode.window.showQuickPick(
      [
        { label: l10n('import.skipField'), value: undefined as string | undefined },
        ...targetColumns.filter((column) => !used.has(column)).map((column) => ({ label: column, value: column })),
      ],
      { placeHolder: `${mapping.source} -> ${mapping.target || l10n('import.skipField')}` },
    );
    if (!choice) return undefined;
    mapping.target = choice.value;
  }
  return mappings.some((mapping) => mapping.target) ? mappings : undefined;
}

async function pickImportDatabase(node: DbTreeNode, getDatabases: () => Promise<string[]>): Promise<string | undefined> {
  if (node.database) return node.database;
  const databases = await getDatabases();
  if (!databases.length) return undefined;
  return vscode.window.showQuickPick(databases, { placeHolder: l10n('import.selectDatabase') });
}

async function pickExportDatabase(node: DbTreeNode, getDatabases: () => Promise<string[]>): Promise<string | undefined> {
  if (node.database) return node.database;
  const databases = await getDatabases();
  if (!databases.length) return undefined;
  return vscode.window.showQuickPick(databases, { placeHolder: l10n('export.selectDatabase') });
}

async function pickTables(getTables: (database?: string) => Promise<{ name: string }[]>, database?: string): Promise<string[] | undefined> {
  const tables = await getTables(database);
  const chosen = await vscode.window.showQuickPick(tables.map((item) => ({ label: item.name, picked: true })), {
    canPickMany: true,
    placeHolder: l10n('export.selectTables'),
  });
  return chosen?.map((item) => item.label);
}

function importFilters(format: TransferFormat): Record<string, string[]> {
  return format === 'csv' ? { CSV: ['csv'] } : format === 'json' ? { JSON: ['json'] } : { 'SQL scripts': ['sql'] };
}

function exportFilters(format: TransferFormat): Record<string, string[]> {
  return format === 'csv' ? { CSV: ['csv'] } : format === 'json' ? { JSON: ['json'] } : { SQL: ['sql'] };
}

async function pickFormat(action: 'import' | 'export'): Promise<TransferFormat | undefined> {
  return (await vscode.window.showQuickPick(
    [
      { label: 'SQL', description: action === 'import' ? l10n('import.formatSql') : l10n('export.formatSql'), value: 'sql' as const },
      { label: 'CSV', description: action === 'import' ? l10n('import.formatCsv') : l10n('export.formatCsv'), value: 'csv' as const },
      { label: 'JSON', description: action === 'import' ? l10n('import.formatJson') : l10n('export.formatJson'), value: 'json' as const },
    ],
    { placeHolder: action === 'import' ? l10n('import.chooseFormat') : l10n('export.chooseFormat') },
  ))?.value;
}

async function showImportReport(row: number, message: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: 'plaintext',
    content: `Import rolled back.\n\nFirst failing source row: ${row}\nError: ${message}\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}
