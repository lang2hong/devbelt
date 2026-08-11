import type { ConnectionManager, ConnectionSession } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import { buildCandidates, detectContext, extractFromTable } from '../completion/sqlCompletionEngine';

/**
 * SQL 补全服务：为 webview 查询编辑器的补全请求生成候选。
 *
 * 与视图解耦：仅依赖 ConnectionManager + 连接配置 + 数据库名 + 消息回调。
 * 表/列元数据带缓存（随实例生命周期存续）。
 */
export class CompletionService {
  private readonly tableCache = new Map<string, string[]>();
  private readonly columnCache = new Map<string, string[]>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly conn: SavedConnection,
    private readonly database: string | undefined,
    private readonly post: (msg: any) => void,
  ) {}

  /** 处理补全请求并向视图发送候选。 */
  async handle(before: string, text: string): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      const db = this.database || this.conn.database;
      const tables = await this.getTables(session, db);
      const fromTable = extractFromTable(text);
      const ctx = detectContext(before);
      let columns: string[] = [];
      if (ctx === 'dot_column') {
        const m = before.match(/(\w+)\.\w*$/);
        if (m) columns = await this.getColumns(session, m[1], db);
      } else if (fromTable) {
        columns = await this.getColumns(session, fromTable, db);
      }
      const items = buildCandidates(ctx, { tables, columns, fromTable });
      this.post({ type: 'completionItems', items });
    } catch {
      this.post({ type: 'completionItems', items: [] });
    }
  }

  private async getTables(session: ConnectionSession, db?: string): Promise<string[]> {
    const key = db || '';
    const cached = this.tableCache.get(key);
    if (cached) return cached;
    try {
      const tables = (await session.metadata.getTables(db)).map((t: any) => t.name);
      this.tableCache.set(key, tables);
      return tables;
    } catch {
      return [];
    }
  }

  private async getColumns(session: ConnectionSession, table: string, db?: string): Promise<string[]> {
    const key = `${db || ''}:${table}`;
    const cached = this.columnCache.get(key);
    if (cached) return cached;
    try {
      const columns = (await session.metadata.getColumns(table, db)).map((c: any) => c.name);
      this.columnCache.set(key, columns);
      return columns;
    } catch {
      return [];
    }
  }
}