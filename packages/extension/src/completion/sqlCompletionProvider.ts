import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import type { ConnectionContext } from '../connection/connectionContext';
import { diagError } from '../utils/diagnostics';
import { SQL_SNIPPETS } from './sqlSnippets';
import {
  buildCandidates,
  detectContext,
  extractFromTable,
  type CompKind,
  type CompletionCandidate,
} from './sqlCompletionEngine';

/**
 * SQL 自动补全提供者（.sql 编辑器）。
 *
 * 复用 sqlCompletionEngine 纯函数引擎判定上下文与候选集，
 * 查询元数据带缓存，映射为 VS Code CompletionItem。
 * VS Code 引擎自带前缀过滤（基于 label），无需手动过滤。
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  /** 表名缓存：connId:db → tableName[] */
  private tableCache = new Map<string, string[]>();
  /** 列名缓存：connId:db:table → columnName[] */
  private columnCache = new Map<string, string[]>();

  constructor(
    private readonly context: ConnectionContext,
    private readonly manager: ConnectionManager,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const ctx = this.context.getForDoc(document.uri.toString());
    const conn = ctx?.conn;
    const text = document.getText();
    const line = text.split('\n')[position.line] || '';
    const before = line.slice(0, position.character);

    // 触发词匹配 snippet（如 sel/del/ins/upd/joi）
    const snippetMatch = before.match(/(\w+)$/);
    if (snippetMatch) {
      const snippets = SQL_SNIPPETS.filter((s) =>
        s.trigger.startsWith(snippetMatch[1].toLowerCase()),
      );
      if (snippets.length) {
        return snippets.map((s) => {
          const item = new vscode.CompletionItem(s.trigger, vscode.CompletionItemKind.Snippet);
          item.label = `${s.trigger} (${s.label})`;
          item.insertText = new vscode.SnippetString(s.body);
          item.detail = s.description;
          item.documentation = s.description;
          return item;
        });
      }
    }

    const db = ctx?.db;
    const sqlCtx = detectContext(before);
    let tables: string[] = [];
    let columns: string[] = [];
    let fromTable: string | undefined;
    if (conn) {
      tables = await this.getTables(conn, db);
      fromTable = extractFromTable(text);
      if (sqlCtx === 'dot_column') {
        const m = before.match(/(\w+)\.\w*$/);
        if (m) columns = await this.getColumns(conn, m[1], db);
      } else if (fromTable) {
        columns = await this.getColumns(conn, fromTable, db);
      }
    }

    const candidates = buildCandidates(sqlCtx, { tables, columns, fromTable });
    return candidates.map((c) => this.toItem(c, db));
  }

  /** 候选 → VS Code CompletionItem，表名带库名限定。 */
  private toItem(c: CompletionCandidate, db?: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(c.label, this.mapKind(c.kind));
    if (c.kind === 'table') {
      item.detail = 'table';
      if (db) {
        item.label = `${db}.${c.label}`;
        item.insertText = c.label;
      }
    }
    return item;
  }

  private mapKind(k: CompKind): vscode.CompletionItemKind {
    switch (k) {
      case 'keyword': return vscode.CompletionItemKind.Keyword;
      case 'table': return vscode.CompletionItemKind.Class;
      case 'column': return vscode.CompletionItemKind.Field;
      case 'function': return vscode.CompletionItemKind.Function;
      case 'operator': return vscode.CompletionItemKind.Operator;
      default: return vscode.CompletionItemKind.Text;
    }
  }

  /** 获取表名列表（带缓存） */
  private async getTables(conn: SavedConnection, database?: string): Promise<string[]> {
    const key = `${conn.id}:${database || ''}`;
    const cached = this.tableCache.get(key);
    if (cached) return cached;
    try {
      const session = await this.manager.connect(conn);
      const tables = await session.metadata.getTables(database);
      const names = tables.map((t) => t.name);
      this.tableCache.set(key, names);
      return names;
    } catch (err) {
      diagError('Completion: getTables failed', { connId: conn.id, database, error: (err as Error).message });
      return [];
    }
  }

  /** 获取列名列表（带缓存） */
  private async getColumns(conn: SavedConnection, table: string, database?: string): Promise<string[]> {
    const key = `${conn.id}:${database || ''}:${table}`;
    const cached = this.columnCache.get(key);
    if (cached) return cached;
    try {
      const session = await this.manager.connect(conn);
      const columns = await session.metadata.getColumns(table, database);
      const names = columns.map((c) => c.name);
      this.columnCache.set(key, names);
      return names;
    } catch (err) {
      diagError('Completion: getColumns failed', { connId: conn.id, table, database, error: (err as Error).message });
      return [];
    }
  }

  /** 清除缓存（连接变更时调用） */
  invalidate(connId?: string): void {
    if (connId) {
      for (const key of this.tableCache.keys()) {
        if (key.startsWith(connId + ':')) this.tableCache.delete(key);
      }
      for (const key of this.columnCache.keys()) {
        if (key.startsWith(connId + ':')) this.columnCache.delete(key);
      }
    } else {
      this.tableCache.clear();
      this.columnCache.clear();
    }
  }
}
