import * as vscode from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import { l10n } from '../i18n';
import { pgSchemaFor } from '../utils/sql';
import { collectDictionary } from '../docs/collectDictionary';
import { renderHtml, renderMarkdown, type DictionaryLabels } from '../docs/dataDictionary';
import type { Deps, Sub } from './shared';

type DictionaryFormat = 'markdown' | 'html';

/** All renderer labels from the active catalog. */
export function dictionaryLabels(): DictionaryLabels {
  const k = (key: string): string => l10n(`dict.${key}`);
  return {
    title: k('title'),
    database: k('database'),
    schema: k('schema'),
    engine: k('engine'),
    generatedAt: k('generatedAt'),
    contents: k('contents'),
    tableCount: k('tableCount'),
    truncated: k('truncated'),
    noTables: k('noTables'),
    rowsEstimate: k('rowsEstimate'),
    columns: k('columns'),
    indexes: k('indexes'),
    foreignKeys: k('foreignKeys'),
    colName: k('colName'),
    colType: k('colType'),
    colNullable: k('colNullable'),
    colDefault: k('colDefault'),
    colComment: k('colComment'),
    colKey: k('colKey'),
    yes: k('yes'),
    no: k('no'),
    primaryKey: k('primaryKey'),
    autoIncrement: k('autoIncrement'),
    unique: k('unique'),
    indexName: k('indexName'),
    indexColumns: k('indexColumns'),
    indexKind: k('indexKind'),
    fkName: k('fkName'),
    fkColumns: k('fkColumns'),
    fkReferences: k('fkReferences'),
    none: k('none'),
  };
}

/** PG `current_schema()`; undefined when it cannot be read (dictionary still exports). */
export async function currentPgSchema(session: { query: { query: (sql: string, values?: unknown, opts?: { skipHistory?: boolean }) => Promise<{ rows?: unknown[] }> } }): Promise<string | undefined> {
  try {
    const res = await session.query.query('SELECT current_schema() AS s', undefined, { skipHistory: true });
    const value = (res?.rows?.[0] as { s?: unknown } | undefined)?.s;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeFileStem(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'database';
}

/**
 * P10 S8：数据字典导出（库节点右键 → 数据 → 生成数据字典）。
 *
 * 只读元数据，只写用户在保存对话框里选定的文件；文档不含任何连接信息或凭据。
 */
export function registerDictionaryCommands(deps: Deps, sub: Sub): void {
  sub('devbelt.generateDictionary', async (node: any) => {
    if (!node?.conn || !node?.database) return;
    const conn = node.conn;
    const database: string = node.database;
    const schema = pgSchemaFor(conn, node.schema);

    const configured = vscode.workspace.getConfiguration().get<string>('devbelt.dictionary.format');
    const preferred: DictionaryFormat = configured === 'html' ? 'html' : 'markdown';
    const options: Array<vscode.QuickPickItem & { value: DictionaryFormat }> = [
      { label: 'Markdown', description: '.md', value: 'markdown' },
      { label: 'HTML', description: '.html', value: 'html' },
    ];
    if (preferred === 'html') options.reverse();
    const picked = await vscode.window.showQuickPick(options, { placeHolder: l10n('dict.pickFormat') });
    if (!picked) return;

    const ext = picked.value === 'html' ? 'html' : 'md';
    const stem = safeFileStem(schema ? `${database}-${schema}` : database);
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const fileName = `${stem}-dictionary.${ext}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: base ? vscode.Uri.joinPath(base, fileName) : vscode.Uri.file(fileName),
      filters: picked.value === 'html' ? { HTML: ['html', 'htm'] } : { Markdown: ['md', 'markdown'] },
    });
    if (!uri) return;

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: l10n('dict.progress'), cancellable: true },
      async (progress, token) => {
        const session = await deps.manager.connectSql(conn, database);
        // PG 库节点没有显式 schema：元数据按 current_schema() 读取，把它写进文档头，
        // 否则读者不知道导出的是哪个 schema。
        const effectiveSchema = schema ?? (conn.dbType === DatabaseType.PG ? await currentPgSchema(session) : undefined);
        let last = 0;
        return collectDictionary(session.metadata, {
          database,
          ...(effectiveSchema ? { schema: effectiveSchema } : {}),
          dbType: String(conn.dbType),
          isCancelled: () => token.isCancellationRequested,
          onProgress: (done, total) => {
            const pct = total ? Math.floor((done / total) * 100) : 100;
            progress.report({ increment: pct - last, message: `${done}/${total}` });
            last = pct;
          },
        });
      },
    );
    if (result.cancelled) {
      void vscode.window.showInformationMessage(l10n('dict.cancelled'));
      return;
    }

    const labels = dictionaryLabels();
    const content = picked.value === 'html' ? renderHtml(result.model, labels) : renderMarkdown(result.model, labels);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));

    const message = result.skipped.length > 0
      ? l10n('dict.doneSkipped', { count: result.model.tables.length, skipped: result.skipped.length })
      : l10n('dict.done', { count: result.model.tables.length });
    const open = l10n('dict.open');
    const choice = await vscode.window.showInformationMessage(message, open);
    if (choice !== open) return;
    if (picked.value === 'markdown') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    } else {
      await vscode.env.openExternal(uri);
    }
  });
}