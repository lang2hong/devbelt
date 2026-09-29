import type { ConnectionManager } from '../connection/connectionManager';
import type { SqlConnectionSession } from '../connection/connectionSession';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { buildCandidates, detectContext, extractFromTable, extractTableAliases, type SqlContext } from '../completion/sqlCompletionEngine';
import { stripSqlComments } from '@devbelt/db-core/sql';
import { diagWarn } from '../utils/diagnostics';
import { pgSchemaFor } from '../utils/sql';

/** 元数据缓存 TTL：DDL 改表后补全不应长期返回陈旧表/列。 */
const CACHE_TTL_MS = 60_000;

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
  private readonly tableCache = new Map<string, { names: string[]; at: number }>();
  private readonly columnCache = new Map<string, { names: string[]; at: number }>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly conn: SavedConnection,
    private readonly database: string | undefined,
    private readonly post: (msg: any) => void,
    /** PG 命名空间（显式 schema；绝不从 database 推断）。 */
    private readonly schema?: string,
  ) {}

  /** 处理补全请求并向视图发送候选。 */
  async handle(before: string, text: string): Promise<void> {
    try {
      const ctx = detectContext(before);
      // 只解析光标所在语句的 FROM：多语句文件里取首个 FROM 会补错表。
      // 剥离注释：注释里出现的 FROM/JOIN 会污染表名解析。
      const stmtText = stripSqlComments(text.slice(before.lastIndexOf(';') + 1));
      const fromTable = extractFromTable(stmtText);
      const db = this.database || this.conn.database;

      let tables: string[] = [];
      let columns: string[] = [];

      if (CONTEXTS_NEEDING_TABLES.includes(ctx) || CONTEXTS_NEEDING_COLUMNS.includes(ctx)) {
        const session = await this.manager.connectSql(this.conn, this.database);
        if (CONTEXTS_NEEDING_TABLES.includes(ctx)) {
          tables = await this.getTables(session, db);
        }
        if (CONTEXTS_NEEDING_COLUMNS.includes(ctx)) {
          if (ctx === 'dot_column') {
            const m = before.match(/(\w+)\.\w*$/);
            if (m) {
              const aliases = extractTableAliases(stmtText);
              columns = await this.getColumns(session, aliases.get(m[1]) ?? m[1], db);
            }
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

  private async getTables(session: SqlConnectionSession, db?: string): Promise<string[]> {
    const key = db || '';
    const cached = this.tableCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.names;
    if (cached) this.tableCache.delete(key);
    try {
      const tables = (await session.metadata.getTables(db, pgSchemaFor(this.conn, this.schema))).map((t: any) => t.name);
      this.tableCache.set(key, { names: tables, at: Date.now() });
      return tables;
    } catch (err) {
      diagWarn('completion getTables failed', (err as Error).message);
      return [];
    }
  }

  private async getColumns(session: SqlConnectionSession, table: string, db?: string): Promise<string[]> {
    const key = `${db || ''}:${table}`;
    const cached = this.columnCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.names;
    if (cached) this.columnCache.delete(key);
    try {
      const columns = (await session.metadata.getColumns(table, db, pgSchemaFor(this.conn, this.schema))).map((c: any) => c.name);
      this.columnCache.set(key, { names: columns, at: Date.now() });
      return columns;
    } catch (err) {
      diagWarn('completion getColumns failed', table, (err as Error).message);
      return [];
    }
  }
}