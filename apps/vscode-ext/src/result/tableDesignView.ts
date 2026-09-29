import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { DialectRegistry, validateIdent } from '@devbelt/db-core';
import type { ColumnSpec } from '@devbelt/db-core';
import { validateColumnType } from '@devbelt/db-core';
import { DataChangeEvent, eventBus } from '@devbelt/db-host/utils/event';
import { AuditLogger } from '../utils/auditLogger';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { pgSchemaFor } from '../utils/sql';
import { l10n } from '../i18n';

/**
 * 把来自 webview 的 `msg.spec` 规整为 ColumnSpec。
 * 只取白名单字段并校验类型，避免 `as ColumnSpec` 把任意 JSON 直接塞进 DDL 构造。
 */
function toColumnSpec(raw: unknown): ColumnSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid column definition.');
  }
  const s = raw as Record<string, unknown>;
  const spec: ColumnSpec = { type: validateColumnType(String(s.type ?? '')) };
  if (s.notNull !== undefined) spec.notNull = Boolean(s.notNull);
  if (s.isPrimary !== undefined) spec.isPrimary = Boolean(s.isPrimary);
  if (s.autoIncrement !== undefined) spec.autoIncrement = Boolean(s.autoIncrement);
  if (s.defaultValue != null) spec.defaultValue = String(s.defaultValue);
  if (s.comment != null) spec.comment = String(s.comment);
  return spec;
}

export class TableDesignView extends BaseWebView {
  private static current?: TableDesignView;

  /** 待建表模式：table 为空，前端展示建表表单。 */
  private table: string;

  private constructor(
    private readonly conn: SavedConnection,
    table: string,
    private readonly database: string,
    private readonly manager: ConnectionManager,
    private readonly onMutate?: () => void,
    /** PG 命名空间（显式 schema；绝不从 database 推断）。 */
    private readonly schema?: string,
  ) {
    super(
      'devbelt.tableDesign',
      table
        ? `Design: ${conn.name || conn.host} › ${database} › ${table}`
        : `New Table: ${conn.name || conn.host} › ${database}`,
    );
    this.table = table;
    this.manager.retain(conn.id);
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static async open(conn: SavedConnection, table: string, database: string, manager: ConnectionManager, onMutate?: () => void, schema?: string): Promise<void> {
    if (TableDesignView.current) TableDesignView.current.dispose();
    const view = new TableDesignView(conn, table, database, manager, onMutate, schema);
    TableDesignView.current = view;
  }

  /**
   * 建表：用同一个设计器承载，而不是丢一段 `CREATE TABLE` 模板到编辑器里。
   * 建完立刻切换为该表的设计视图，可以接着加列/加索引。
   */
  static async openNew(conn: SavedConnection, database: string, manager: ConnectionManager, onMutate?: () => void, schema?: string): Promise<void> {
    if (TableDesignView.current) TableDesignView.current.dispose();
    TableDesignView.current = new TableDesignView(conn, '', database, manager, onMutate, schema);
  }

  /**
   * 消息入口。
   *
   * 统一兜住校验异常：校验分支（`validateDesignIdent` / `validateDefinition`）
   * 抛在 `mutate` 的 try 之外，过去只会落进 diagnostics 日志，
   * 界面上点了「保存」毫无反应。
   */
  protected async handleMessage(msg: any): Promise<void> {
    try {
      await this.dispatch(msg);
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async dispatch(msg: any): Promise<void> {
    if (msg.type === 'ready') {
      // 列类型候选由方言提供，避免前端硬编码 MySQL 类型集合。
      this.post({
        type: 'init',
        mode: 'design',
        dbType: this.conn.dbType,
        columnTypes: this.columnTypes(),
        creating: !this.table,
        tableName: this.table,
        dbName: this.database,
      });
      if (this.table) await this.loadData();
      return;
    }
    if (msg.type === 'createTable') {
      await this.createTable(msg);
      return;
    }
    // 建表未完成前不接受任何针对表的 DDL（表还不存在）
    if (!this.table) return;
    if (msg.type === 'addColumn') {
      this.validateDesignIdent(msg.column, 'column');
      await this.mutate(`ALTER TABLE ${this.table} ADD COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.addColumn(this.table, msg.column, toColumnSpec(msg.spec), this.database, this.pgSchema);
      });
      return;
    }
    if (msg.type === 'dropColumn') {
      this.validateDesignIdent(msg.column, 'column');
      await this.mutate(`ALTER TABLE ${this.table} DROP COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.dropColumn(this.table, msg.column, this.database, this.pgSchema);
      });
      return;
    }
    if (msg.type === 'modifyColumn') {
      this.validateDesignIdent(msg.column, 'column');
      await this.mutate(`ALTER TABLE ${this.table} MODIFY COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.modifyColumn(this.table, msg.column, toColumnSpec(msg.spec), this.database, this.pgSchema);
      });
      return;
    }
    if (msg.type === 'reorderColumn') {
      this.validateDesignIdent(msg.column, 'column');
      await this.mutate(`ALTER TABLE ${this.table} REORDER COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.reorderColumn(this.table, msg.column, msg.afterColumn ?? null, this.database, this.pgSchema);
      });
      return;
    }
    if (msg.type === 'addIndex') {
      this.validateDesignIdent(msg.name, 'index');
      await this.mutate(`CREATE INDEX ${msg.name} ON ${this.table}`, async () => {
        const session = await this.session();
        await session.table.createIndex(msg.name, this.table, Array.isArray(msg.columns) ? msg.columns : [], this.database, !!msg.isUnique, this.pgSchema);
      });
      return;
    }
    if (msg.type === 'editIndex') {
      this.validateDesignIdent(msg.oldName, 'index');
      if (msg.name) this.validateDesignIdent(msg.name, 'index');
      await this.mutate(`ALTER INDEX ${msg.oldName} ON ${this.table}`, async () => {
        const session = await this.session();
        const cols = Array.isArray(msg.columns) ? msg.columns : [];
        if (String(msg.oldName).toUpperCase() === 'PRIMARY') {
          await session.table.recreatePrimaryKey(this.table, cols, this.database, this.pgSchema);
        } else {
          await session.table.dropIndex(msg.oldName, this.table, this.database, this.pgSchema);
          await session.table.createIndex(msg.name, this.table, cols, this.database, !!msg.isUnique, this.pgSchema);
        }
      });
      return;
    }
    if (msg.type === 'dropIndex') {
      this.validateDesignIdent(msg.name, 'index');
      await this.mutate(`DROP INDEX ${msg.name} ON ${this.table}`, async () => {
        const session = await this.session();
        await session.table.dropIndex(msg.name, this.table, this.database, this.pgSchema);
      });
      return;
    }
  }

  /**
   * 建表。列定义由前端逐项给出（名/类型/非空/默认/注释/自增），
   * 主键与自增在这里合成 —— 三家方言的自增写法完全不同，交给 db-core 处理。
   */
  private async createTable(msg: any): Promise<void> {
    const name = String(msg.table ?? '').trim();
    this.validateDesignIdent(name, 'table');
    const columns = Array.isArray(msg.columns) ? msg.columns : [];
    if (!columns.length) throw new Error('At least one column is required to create a table.');
    const spec = columns.map((c: any) => {
      const columnName = String(c.name ?? '').trim();
      this.validateDesignIdent(columnName, 'column');
      const type = String(c.type ?? '').trim();
      return {
        name: columnName,
        type,
        notNull: !!c.notNull,
        isPrimary: !!c.isPrimary,
        autoIncrement: !!c.autoIncrement,
        defaultValue: typeof c.defaultValue === 'string' && c.defaultValue.trim() !== ''
          ? c.defaultValue.trim()
          : undefined,
        comment: typeof c.comment === 'string' && c.comment.trim() !== '' ? c.comment.trim() : undefined,
      };
    });
    await this.mutate(`CREATE TABLE ${name}`, async () => {
      const session = await this.session();
      await session.table.createTable(name, spec, this.database, this.pgSchema);
      this.table = name;
      this.panel.title = `Design: ${this.conn.name || this.conn.host} › ${this.database} › ${name}`;
      this.post({ type: 'created', tableName: name });
    });
  }

  private async session() {
    return this.manager.connectSql(this.conn, this.database);
  }

  /** PG 命名空间限定：设计器作用域用**显式 schema**（不从 database 推断）。 */
  private get pgSchema(): string | undefined {
    return pgSchemaFor(this.conn, this.schema);
  }

  /** 取本连接方言的列类型候选；方言未注册时返回空列表（前端退化为纯文本输入）。 */
  private columnTypes(): readonly string[] {
    try {
      return DialectRegistry.get(this.conn.dbType).columnTypes;
    } catch {
      return [];
    }
  }

  /**
   * 所有 DDL 变更的唯一出口：执行 → 重载 → 通知。
   *
   * 审计与事件在这里统一发出，避免每个 msg 分支各写一遍（漏一处就少一条痕迹）。
   * schema_change 与 DataChangeEvent('ddl') 此前都没有任何写入点。
   *
   * 设计器内的列/索引增删改**不在开发环境重复确认**：用户是在一个专门的结构
   * 编辑界面里主动点的按钮，每次都弹模态框反而是噪音。只读连接拦截仍然保留 ——
   * 那是能力边界，不是提示。**生产环境例外**：结构变更与其它 DDL 同口径，
   * 需要模态确认后才执行。
   */
  private async mutate(op: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      if (this.conn.readOnly) {
        // 错误回投到 webview 而不是弹 VS Code 提示：用户的注意力在面板里。
        this.post({
          type: 'error',
          message: l10n('conn.readOnlyBlocked', { name: this.conn.name || this.conn.host }),
        });
        return;
      }
      if (this.conn.environment === 'production' && !(await confirmSqlExecution(this.conn, op, this.manager.scanOptionsFor?.(this.conn), { database: this.database, schema: this.pgSchema }))) {
        return;
      }
      await fn();
      AuditLogger.tryLog({
        action: 'schema_change',
        connName: this.conn.name || this.conn.host,
        database: this.database,
        schema: this.pgSchema,
        sql: op,
      });
      void eventBus.publish(new DataChangeEvent(this.conn.id, this.database ?? '', this.table, 'ddl', this.pgSchema));
      await this.loadData();
      this.onMutate?.();
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private validateDesignIdent(name: string, context: string): void {
    if (!name || typeof name !== 'string') {
      throw new Error(`Invalid ${context} name`);
    }
    validateIdent(name);
  }

  private async loadData(): Promise<void> {
    try {
      const session = await this.manager.connectSql(this.conn, this.database);
      const [columns, indexes, ddl] = await Promise.all([
        session.metadata.getColumns(this.table, this.database, this.pgSchema),
        session.metadata.getIndexes(this.table, this.database, this.pgSchema),
        session.table.getCreateSql(this.table, this.database, this.pgSchema),
      ]);
      this.post({ type: 'data', columns, indexes, ddl });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (TableDesignView.current === this) TableDesignView.current = undefined;
    this.manager.release(this.conn.id);
  }
}
