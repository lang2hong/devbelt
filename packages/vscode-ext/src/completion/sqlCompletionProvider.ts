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

    // FROM/JOIN/UPDATE/INTO 后面补表名（带库名限定）
    if (/\b(FROM|JOIN|UPDATE|INTO)\s+\w*$/i.test(before)) {
      const tables = await this.getTables(conn, context?.db);
      return tables.map((t) => this.makeTableItem(t, context?.db));
    }

    // 表名后跟 . 补列名（如 `table.`）
    const colMatch = before.match(/(\w+)\.\w*$/);
    if (colMatch) {
      const cols = await this.getColumns(conn, colMatch[1], context?.db);
      return cols.map((c) => this.makeItem(c, vscode.CompletionItemKind.Field));
    }

    // SELECT/WHERE/ORDER/GROUP/HAVING/AND/OR/ON/SET 后或逗号后补列名（基于 FROM 表）
    if (/\b(SELECT|WHERE|ORDER|GROUP|HAVING|AND|OR|ON|SET)\s+\w*$/i.test(before) || /,\s*\w*$/.test(before)) {
      const fromTable = this.extractFromTable(text);
      if (fromTable) {
        const cols = await this.getColumns(conn, fromTable, context?.db);
        if (cols.length) return cols.map((c) => this.makeItem(c, vscode.CompletionItemKind.Field));
      }
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
    return tables.map((t) => this.makeTableItem(t, database));
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
      'CONCAT', 'NOW', 'CURDATE', 'CURTIME', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME',
      'DATE_FORMAT', 'STR_TO_DATE', 'IFNULL', 'COALESCE', 'NULLIF', 'CAST', 'CONVERT',
      'SUBSTRING', 'LENGTH', 'TRIM', 'LOWER', 'UPPER', 'REPLACE', 'LEFT', 'RIGHT',
      'ROUND', 'CEIL', 'FLOOR', 'ABS', 'MOD', 'GREATEST', 'LEAST', 'DATE', 'DATEDIFF',
    ];
    return keywords.map((kw) => this.makeItem(kw, vscode.CompletionItemKind.Keyword));
  }

  private makeItem(label: string, kind: vscode.CompletionItemKind): vscode.CompletionItem {
    const item = new vscode.CompletionItem(label, kind);
    return item;
  }

  private makeTableItem(table: string, database?: string): vscode.CompletionItem {
    const label = database ? `${database}.${table}` : table;
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Class);
    item.detail = 'table';
    return item;
  }

  /** 从 SQL 文本提取 FROM 后的表名（取最后一段，去掉库名前缀） */
  private extractFromTable(text: string): string | undefined {
    const m = text.match(/\bFROM\s+([\w.]+)/i);
    if (!m) return undefined;
    return m[1].split('.').pop();
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
