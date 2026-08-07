import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/connectionManager';
import type { ConnectionStore, SavedConnection } from '../connection/connectionStore';

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
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const conn = this.guessConnection(document);
    if (!conn) return this.keywordItems();

    const text = document.getText();
    const line = text.split('\n')[position.line] || '';
    const before = line.slice(0, position.character);

    // FROM/JOIN/UPDATE/INTO 后面补表名
    if (/\b(FROM|JOIN|UPDATE|INTO)\s+\w*$/i.test(before)) {
      const tables = await this.getTables(conn);
      return tables.map((t) => this.makeItem(t, vscode.CompletionItemKind.Class));
    }

    // 表名后跟 . 补列名（如 `table.`）
    const colMatch = before.match(/(\w+)\.\w*$/);
    if (colMatch) {
      const cols = await this.getColumns(conn, colMatch[1]);
      return cols.map((c) => this.makeItem(c, vscode.CompletionItemKind.Field));
    }

    // 默认：关键字 + 表名
    return [...this.keywordItems(), ...(await this.tableItems(conn))];
  }

  /** 从文档内容猜测当前使用的连接（匹配 use/database 语句或回退到第一个） */
  private guessConnection(_doc: vscode.TextDocument): SavedConnection | undefined {
    // 简化：返回第一个已保存连接（后续可解析 USE 语句）
    return this.store.list()[0];
  }

  /** 获取表名列表（带缓存） */
  private async getTables(conn: SavedConnection): Promise<string[]> {
    const cached = this.tableCache.get(conn.id);
    if (cached) return cached;
    try {
      const session = await this.manager.connect(conn);
      const tables = await session.metadata.getTables();
      const names = tables.map((t) => t.name);
      this.tableCache.set(conn.id, names);
      return names;
    } catch {
      return [];
    }
  }

  /** 获取列名列表（带缓存） */
  private async getColumns(conn: SavedConnection, table: string): Promise<string[]> {
    const key = `${conn.id}:${table}`;
    const cached = this.columnCache.get(key);
    if (cached) return cached;
    try {
      const session = await this.manager.connect(conn);
      const columns = await session.metadata.getColumns(table);
      const names = columns.map((c) => c.name);
      this.columnCache.set(key, names);
      return names;
    } catch {
      return [];
    }
  }

  private async tableItems(conn: SavedConnection): Promise<vscode.CompletionItem[]> {
    const tables = await this.getTables(conn);
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
      this.tableCache.delete(connId);
      for (const key of this.columnCache.keys()) {
        if (key.startsWith(connId + ':')) this.columnCache.delete(key);
      }
    } else {
      this.tableCache.clear();
      this.columnCache.clear();
    }
  }
}
