import type { ConnectionManager, ConnectionSession } from '../connection/connectionManager';
import type { SavedConnection } from '@devkit/db-host/connection/connectionStore';
import { buildCandidates, detectContext, extractFromTable, type SqlContext } from '../completion/sqlCompletionEngine';
import { diagWarn } from '../utils/diagnostics';

const CONTEXTS_NEEDING_TABLES: SqlContext[] = ['statement_start', 'from_table_typing'];
const CONTEXTS_NEEDING_COLUMNS: SqlContext[] = [
  'dot_column', 'select_clause', 'after_table', 'where_condition',
  'where_value', 'order_clause', 'set_clause',
];

/**
 * SQL 补全服务：为 webview 查询编辑器的补全请求生成候选。
 *
 * 与视图解耦：仅依赖 ConnectionManager + 连接配置 + 数据库名 + 消息回调。
 * 表/列元数据带缓存（随实例生命周期存续）。
 * 无元数据需求的上下文（如 where_operator）跳过 DB 查询，避免无谓击库。
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
      const ctx = detectContext(before);
      const fromTable = extractFromTable(text);
      const db = this.database || this.conn.database;

      let tables: string[] = [];
      let columns: string[] = [];

      if (CONTEXTS_NEEDING_TABLES.includes(ctx) || CONTEXTS_NEEDING_COLUMNS.includes(ctx)) {
        const session = await this.manager.connect(this.conn);
        if (CONTEXTS_NEEDING_TABLES.includes(ctx)) {
          tables = await this.getTables(session, db);
        }
        if (CONTEXTS_NEEDING_COLUMNS.includes(ctx)) {
          if (ctx === 'dot_column') {
            const m = before.match(/(\w+)\.\w*$/);
            if (m) columns = await this.getColumns(session, m[1], db);
          } else if (fromTable) {
            columns = await this.getColumns(session, fromTable, db);
          }
        }
      }

      const items = buildCandidates(ctx, { tables, columns, fromTable });
      this.post({ type: 'completionItems', items });
    } catch (err) {
      diagWarn('completion metadata failed', (err as Error).message);
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
    } catch (err) {
      diagWarn('completion getTables failed', (err as Error).message);
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
    } catch (err) {
      diagWarn('completion getColumns failed', table, (err as Error).message);
      return [];
    }
  }
}