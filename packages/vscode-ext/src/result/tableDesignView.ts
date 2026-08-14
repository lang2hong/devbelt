import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { DialectRegistry, validateIdent } from '@db-client/core';
import { DataChangeEvent, eventBus } from '../utils/event';
import { AuditLogger } from '../utils/auditLogger';
import { l10n } from '../i18n';

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
  ) {
    super(
      'dbclient.tableDesign',
      table
        ? `Design: ${conn.name || conn.host} › ${database} › ${table}`
        : `New Table: ${conn.name || conn.host} › ${database}`,
    );
    this.table = table;
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static async open(conn: SavedConnection, table: string, database: string, manager: ConnectionManager, onMutate?: () => void): Promise<void> {
    if (TableDesignView.current) TableDesignView.current.dispose();
    const view = new TableDesignView(conn, table, database, manager, onMutate);
    TableDesignView.current = view;
  }

  /**
   * 建表：用同一个设计器承载，而不是丢一段 `CREATE TABLE` 模板到编辑器里。
   * 建完立刻切换为该表的设计视图，可以接着加列/加索引。
   */
  static async openNew(conn: SavedConnection, database: string, manager: ConnectionManager, onMutate?: () => void): Promise<void> {
    if (TableDesignView.current) TableDesignView.current.dispose();
    TableDesignView.current = new TableDesignView(conn, '', database, manager, onMutate);
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
      this.validateDefinition(msg.definition, 'column');
      await this.mutate(`ALTER TABLE ${this.table} ADD COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.addColumn(this.table, msg.column, msg.definition, this.database);
      });
      return;
    }
    if (msg.type === 'dropColumn') {
      this.validateDesignIdent(msg.column, 'column');
      await this.mutate(`ALTER TABLE ${this.table} DROP COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.dropColumn(this.table, msg.column, this.database);
      });
      return;
    }
    if (msg.type === 'modifyColumn') {
      this.validateDesignIdent(msg.column, 'column');
      this.validateDefinition(msg.definition, 'column');
      await this.mutate(`ALTER TABLE ${this.table} MODIFY COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.modifyColumn(this.table, msg.column, msg.definition, this.database);
      });
      return;
    }
    if (msg.type === 'reorderColumn') {
      this.validateDesignIdent(msg.column, 'column');
      await this.mutate(`ALTER TABLE ${this.table} REORDER COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.reorderColumn(this.table, msg.column, msg.afterColumn ?? null, this.database);
      });
      return;
    }
    if (msg.type === 'addIndex') {
      this.validateDesignIdent(msg.name, 'index');
      await this.mutate(`CREATE INDEX ${msg.name} ON ${this.table}`, async () => {
        const session = await this.session();
        await session.table.createIndex(msg.name, this.table, Array.isArray(msg.columns) ? msg.columns : [], this.database, !!msg.isUnique);
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
          await session.table.recreatePrimaryKey(this.table, cols, this.database);
        } else {
          await session.table.dropIndex(msg.oldName, this.table, this.database);
          await session.table.createIndex(msg.name, this.table, cols, this.database, !!msg.isUnique);
        }
      });
      return;
    }
    if (msg.type === 'dropIndex') {
      this.validateDesignIdent(msg.name, 'index');
      await this.mutate(`DROP INDEX ${msg.name} ON ${this.table}`, async () => {
        const session = await this.session();
        await session.table.dropIndex(msg.name, this.table, this.database);
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
      this.validateDefinition(type, 'column');
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
      await session.table.createTable(name, spec, this.database);
      this.table = name;
      this.panel.title = `Design: ${this.conn.name || this.conn.host} › ${this.database} › ${name}`;
      this.post({ type: 'created', tableName: name });
    });
  }

  private async session() {
    return this.manager.connect(this.conn);
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
   * 设计器内的列/索引增删改**不再二次确认**：用户是在一个专门的结构编辑界面里
   * 主动点的按钮，每次都弹模态框反而是噪音。只读连接拦截仍然保留 ——
   * 那是能力边界，不是提示。
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
      await fn();
      AuditLogger.tryLog({
        action: 'schema_change',
        connName: this.conn.name || this.conn.host,
        database: this.database,
        sql: op,
      });
      void eventBus.publish(new DataChangeEvent(this.conn.id, this.database ?? '', this.table, 'ddl'));
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

  /**
   * 校验列定义片段。
   *
   * 定义串由本视图自行拼装（类型 + NOT NULL + DEFAULT + COMMENT），其中
   * DEFAULT 与 COMMENT 的字符串字面量必然带单引号。此前一律拒绝 `'`，
   * 导致任何字符串默认值或列注释都无法保存。
   *
   * 改为拒绝语句分隔符与注释起始符，并要求单引号成对闭合（内部 `''` 为转义），
   * 从而在允许合法字面量的同时阻止跳出定义上下文。
   */
  private validateDefinition(def: string, context: string): void {
    if (!def || typeof def !== 'string' || def.length > 500) {
      throw new Error(`Invalid ${context} definition`);
    }
    if (/;|--|\/\*|\*\//.test(def)) {
      throw new Error(`${context} definition contains invalid characters`);
    }
    // 去掉转义的 '' 后，剩余单引号数量必须为偶数（全部成对闭合）
    const quotes = def.replace(/''/g, '').match(/'/g)?.length ?? 0;
    if (quotes % 2 !== 0) {
      throw new Error(`${context} definition has an unterminated string literal`);
    }
  }

  private async loadData(): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      const [columns, indexes, ddl] = await Promise.all([
        session.metadata.getColumns(this.table, this.database),
        session.metadata.getIndexes(this.table, this.database),
        session.table.getCreateSql(this.table, this.database),
      ]);
      this.post({ type: 'data', columns, indexes, ddl });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (TableDesignView.current === this) TableDesignView.current = undefined;
    if (!this.manager.isExplicit(this.conn.id)) {
      this.manager.disposeConn(this.conn.id);
    }
  }
}
