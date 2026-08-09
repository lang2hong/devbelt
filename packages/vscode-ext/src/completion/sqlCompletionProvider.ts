import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import type { ConnectionContext } from '../connection/connectionContext';
import { SQL_SNIPPETS } from './sqlSnippets';

/**
 * SQL 自动补全提供者。
 *
 * 为 SQL 编辑器提供表名、列名、SQL 关键字补全。
 * 复用已建立的连接会话查询元数据，首次查询后缓存。
 *
 * 设计模式：CompletionItemProvider（VSCode 策略模式）
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  /** 表名缓存：connId → tableName[] */
  private tableCache = new Map<string, string[]>();
  /** 列名缓存：connId:table → columnName[] */
  private columnCache = new Map<string, string[]>();

  constructor(
    private readonly context: ConnectionContext,
    private readonly manager: ConnectionManager,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const context = this.context.getForDoc(document.uri.toString());
    const conn = context?.conn;
    if (!conn) return this.keywordItems();

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

    // FROM/JOIN/UPDATE/INTO 后面补表名
    if (/\b(FROM|JOIN|UPDATE|INTO)\s+\w*$/i.test(before)) {
      const tables = await this.getTables(conn, context?.db);
      return tables.map((t) => this.makeItem(t, vscode.CompletionItemKind.Class));
    }

    // 表名后跟 . 补列名（如 `table.`）
    const colMatch = before.match(/(\w+)\.\w*$/);
    if (colMatch) {
      const cols = await this.getColumns(conn, colMatch[1], context?.db);
      return cols.map((c) => this.makeItem(c, vscode.CompletionItemKind.Field));
    }

    // 默认：关键字 + 表名
    return [...this.keywordItems(), ...(await this.tableItems(conn, context?.db))];
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
    } catch {
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
    } catch {
      return [];
    }
  }

  private async tableItems(conn: SavedConnection, database?: string): Promise<vscode.CompletionItem[]> {
    const tables = await this.getTables(conn, database);
    return tables.map((t) => this.makeItem(t, vscode.CompletionItemKind.Class));
  }

  /** SQL 关键字补全 */
  private keywordItems(): vscode.CompletionItem[] {
    const keywords = [
      'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
      'ALTER', 'TABLE', 'INDEX', 'VIEW', 'DATABASE', 'INTO', 'VALUES', 'SET',
      'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AND', 'OR', 'NOT', 'NULL',
      'IS', 'IN', 'LIKE', 'BETWEEN', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT',
      'OFFSET', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'IF', 'EXISTS',
      'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT', 'AUTO_INCREMENT',
      'PROCEDURE', 'FUNCTION', 'EVENT', 'TRIGGER', 'SHOW', 'DESCRIBE', 'EXPLAIN',
    ];
    return keywords.map((kw) => this.makeItem(kw, vscode.CompletionItemKind.Keyword));
  }

  private makeItem(label: string, kind: vscode.CompletionItemKind): vscode.CompletionItem {
    const item = new vscode.CompletionItem(label, kind);
    return item;
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
