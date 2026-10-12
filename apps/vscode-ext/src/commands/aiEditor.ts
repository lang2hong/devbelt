import * as vscode from 'vscode';
import { parseSqlAnswer } from '@devbelt/ai-core';
import { DatabaseType, validateIdent } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { makeSub } from './shared.js';
import { l10n } from '../i18n';
import { classifyWriteKind } from '../utils/sqlRisk';
import { readAiConfig, type AiService } from '../ai/aiService.js';
import { AiContextStore } from '../ai/aiContextStore.js';
import { AiSchemaContextBuilder } from '../ai/schemaContext.js';
import { AiStatusBar } from '../ai/aiStatusBar.js';
import type { ExternalAiRequest } from '../ai/aiBridge.js';
import {
  assembleExplainMessages,
  assembleNl2SqlMessages,
  assembleOptimizeMessages,
  extractReferencedTables,
  resolveEditorContext,
  type RefinePayload,
} from '../ai/nl2sqlRunner.js';
import type { ConnectionContext } from '../connection/connectionContext.js';
import type { ConnectionManager } from '../connection/connectionManager.js';

export interface AiEditorDeps {
  context: vscode.ExtensionContext;
  connCtx: ConnectionContext;
  manager: ConnectionManager;
  service: AiService;
  contextStore: AiContextStore;
  schemaBuilder: AiSchemaContextBuilder;
  statusBar: AiStatusBar;
  /** 打开 Chat 并发起请求（组合根经 AiBridge 提供）。 */
  requestChat: (request: ExternalAiRequest) => void;
  /** 打开 Chat 并预填"细化"上下文（Alt+A 状态条回路）。 */
  openChatRefine: (payload: RefinePayload) => void;
}

/**
 * SQL 编辑器 AI 命令（P9 S4，§6.11.1）：
 * - `devbelt.ai.explainSql`：选区/整段 SQL → explain 场景，结果回 Chat；
 * - `devbelt.ai.optimizeSql`：先 EXPLAIN（需活动连接），SQL+计划 → optimize，结果回 Chat；
 * - `devbelt.ai.nl2sqlGhost`：选区自然语言 → SQL，解析三字段后 TextEdit 直插 +
 *   状态条（真 ghost 预览随 S5 Inline provider）；
 * - `devbelt.ai.nl2sqlDetails`：状态条点击 → 复述/假设详情 + "在 Chat 中细化"；
 * - `devbelt.ai.openChatRefine`：带上下文打开 Chat（用户直接改述）。
 */
export function registerAiEditorCommands(deps: AiEditorDeps): void {
  const sub = makeSub(deps.context);

  sub('devbelt.ai.explainSql', async () => {
    const editor = vscode.window.activeTextEditor;
    const sql = activeSql(editor);
    if (!sql) {
      void vscode.window.showWarningMessage(l10n('ai.editor.noSql'));
      return;
    }
    const ctx = await resolveEditorContext(deps, editor!.document.uri.toString());
    deps.requestChat({
      feature: 'explain',
      messages: assembleExplainMessages(sql, ctx),
      title: l10n('ai.scenario.explain'),
      ...(ctx.conn ? { connName: ctx.conn.name } : {}),
      ...(ctx.database ? { database: ctx.database } : {}),
    });
  });

  sub('devbelt.ai.optimizeSql', async () => {
    const editor = vscode.window.activeTextEditor;
    const sql = activeSql(editor);
    if (!sql) {
      void vscode.window.showWarningMessage(l10n('ai.editor.noSql'));
      return;
    }
    const ctx = await resolveEditorContext(deps, editor!.document.uri.toString());
    if (!ctx.conn) {
      void vscode.window.showWarningMessage(l10n('ai.editor.noConnection'));
      return;
    }
    const explainText = await runExplain(deps.manager, ctx.conn, ctx.database, sql);
    deps.requestChat({
      feature: 'optimize',
      messages: assembleOptimizeMessages(sql, explainText, ctx),
      title: l10n('ai.scenario.optimize'),
      connName: ctx.conn.name,
      ...(ctx.database ? { database: ctx.database } : {}),
    });
  });

  sub('devbelt.ai.nl2sqlGhost', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const selected = editor.selection.isEmpty ? '' : editor.document.getText(editor.selection).trim();
    const request = selected || (await vscode.window.showInputBox({
      prompt: l10n('ai.nl2sql.prompt'),
      ignoreFocusOut: true,
    }));
    if (!request?.trim()) return;

    const ctx = await resolveEditorContext(deps, editor.document.uri.toString());
    const referencedTables = extractReferencedTables(request);
    const config = readAiConfig();
    try {
      const result = await deps.service.chat(
        {
          model: config.model || 'default',
          messages: assembleNl2SqlMessages({ request, ctx, referencedTables, contextStore: deps.contextStore }),
          temperature: config.temperature,
          feature: 'nl2sql',
        },
        {
          feature: 'nl2sql',
          ...(ctx.conn ? { connName: ctx.conn.name } : {}),
          ...(ctx.database ? { database: ctx.database } : {}),
        },
      );
      const parsed = parseSqlAnswer(result.content);
      if (!parsed.sql) {
        void vscode.window.showWarningMessage(
          l10n('ai.nl2sql.noSql', { msg: parsed.intentParaphrase || l10n('ai.nl2sql.noSqlFallback') }),
        );
        return;
      }
      const inserted = await insertSql(editor, parsed.sql);
      if (!inserted) return;
      deps.statusBar.show({
        request,
        sql: parsed.sql,
        paraphrase: parsed.intentParaphrase,
        assumptions: parsed.assumptions,
        ...(ctx.conn ? { connId: ctx.conn.id, connName: ctx.conn.name } : {}),
        ...(ctx.database ? { database: ctx.database } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(l10n('ai.editor.failed', { msg: message }));
    }
  });

  sub('devbelt.ai.nl2sqlDetails', async () => {
    const last = deps.statusBar.getLast();
    if (!last) return;
    const items: Array<vscode.QuickPickItem & { action?: 'refine' }> = [
      { label: `$(lightbulb) ${l10n('ai.status.paraphrase')}`, detail: last.paraphrase || l10n('ai.status.none') },
    ];
    if (last.assumptions.length > 0) {
      for (const assumption of last.assumptions) {
        items.push({ label: `$(warning) ${assumption}` });
      }
    } else {
      items.push({ label: `$(check) ${l10n('ai.status.noAssumptions')}` });
    }
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(comment-discussion) ${l10n('ai.status.refine')}`, action: 'refine' },
    );
    const picked = await vscode.window.showQuickPick(items, { placeHolder: l10n('ai.status.details') });
    if (picked?.action === 'refine') await vscode.commands.executeCommand('devbelt.ai.openChatRefine');
  });

  sub('devbelt.ai.openChatRefine', () => {
    const last = deps.statusBar.getLast();
    if (!last) return;
    deps.openChatRefine({
      request: last.request,
      sql: last.sql,
      paraphrase: last.paraphrase,
      assumptions: last.assumptions,
      ...(last.connId ? { connId: last.connId } : {}),
      ...(last.connName ? { connName: last.connName } : {}),
      ...(last.database ? { database: last.database } : {}),
    });
  });
}

/** 选区文本（非空）优先，否则整段文档；空文档/纯空白返回 undefined。 */
function activeSql(editor: vscode.TextEditor | undefined): string | undefined {
  if (!editor) return undefined;
  const selected = editor.selection.isEmpty ? '' : editor.document.getText(editor.selection).trim();
  const text = selected || editor.document.getText().trim();
  return text || undefined;
}

/** TextEdit 直插：选区存在则替换选区，否则插到光标处（单次可 undo）。 */
async function insertSql(editor: vscode.TextEditor, sql: string): Promise<boolean> {
  return editor.edit((builder) => {
    if (editor.selection.isEmpty) builder.insert(editor.selection.active, sql);
    else builder.replace(editor.selection, sql);
  });
}

/**
 * 命令侧 EXPLAIN（只读；需活动连接）。
 *
 * 与 QueryRunner.doExplain 同规则：SQLite 用 EXPLAIN QUERY PLAN（人类可读）、
 * MySQL/PG 用不带 ANALYZE 的 EXPLAIN（无写库副作用）、DDL 跳过。
 * 这里独立实现（命令不持有 TableQueryView 的 runner），返回格式化文本供 optimize prompt。
 */
async function runExplain(
  manager: ConnectionManager,
  conn: SavedConnection,
  database: string | undefined,
  sql: string,
): Promise<string | undefined> {
  try {
    const session = await manager.connectSql(conn, database);
    const db = database || conn.database;
    if (db && conn.dbType === DatabaseType.MYSQL) {
      await session.query.query(`USE ${session.query.wrap(validateIdent(db))}`);
    }
    const prefix = conn.dbType === DatabaseType.SQLITE ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
    const scanOptions = manager.scanOptionsFor?.(conn);
    const ddl = classifyWriteKind(sql, scanOptions) === 'ddl';
    if (ddl) return undefined;
    const result = await session.query.query(`${prefix}${sql}`);
    const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
    return rows.map((row) => JSON.stringify(row)).join('\n') || undefined;
  } catch {
    return undefined; // 取不到计划不阻塞 optimize（prompt 里会省略 EXPLAIN 段）
  }
}