import { DataDiffService, type DataDiffResult } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { l10n } from '../i18n';
import { AuditLogger } from '../utils/auditLogger';

export class DataDiffView extends BaseWebView {
  private static current?: DataDiffView;

  private constructor(
    private readonly sourceConn: SavedConnection,
    private readonly sourceDb: string,
    private readonly targetConn: SavedConnection,
    private readonly targetDb: string,
    private readonly manager: ConnectionManager,
    private readonly sourceSchema?: string,
    private readonly targetSchema?: string,
  ) {
    const src = sourceSchema ? `${sourceDb}.${sourceSchema}` : sourceDb;
    const tgt = targetSchema ? `${targetDb}.${targetSchema}` : targetDb;
    super('devbelt.dataDiff', `Data Diff: ${src} → ${tgt}`);
    this.manager.retain(sourceConn.id);
    this.manager.retain(targetConn.id);
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static async open(
    sourceConn: SavedConnection,
    sourceDb: string,
    targetConn: SavedConnection,
    targetDb: string,
    manager: ConnectionManager,
    sourceSchema?: string,
    targetSchema?: string,
  ): Promise<void> {
    if (DataDiffView.current) DataDiffView.current.dispose();
    const view = new DataDiffView(sourceConn, sourceDb, targetConn, targetDb, manager, sourceSchema, targetSchema);
    DataDiffView.current = view;
  }


  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        this.post({ type: 'init', mode: 'dataDiff' });
        return;
      }
      await this.loadDiff();
      return;
    }
    if (msg.type === 'applySync') {
      try {
        const diff = await this.computeDiff();
        const session = await this.manager.connectSql(this.targetConn, this.targetDb);
        const sql = DataDiffService.generateSyncSql(diff, this.targetDb, session.query, this.targetSchema);
        // 破坏性 DML：先经只读/生产/高危确认门禁，再执行并审计。
        if (!(await confirmSqlExecution(this.targetConn, sql, this.manager.scanOptionsFor?.(this.targetConn), { database: this.targetDb, schema: this.targetSchema }))) {
          this.post({ type: 'error', message: l10n('transfer.cancelled') });
          return;
        }
        const started = Date.now();
        await session.query.query(sql);
        AuditLogger.tryLog({
          action: 'data_sync',
          connName: this.targetConn.name || this.targetConn.host,
          database: this.targetDb,
          schema: this.targetSchema,
          sql,
          costTime: Date.now() - started,
        });
        this.post({ type: 'applied' });
        this.dispose();
      } catch (err) {
        this.post({ type: 'error', message: (err as Error).message });
      }
      return;
    }
  }

  private async computeDiff(): Promise<DataDiffResult> {
    const sourceSession = await this.manager.connectSql(this.sourceConn, this.sourceDb);
    const targetSession = await this.manager.connectSql(this.targetConn, this.targetDb);
    return DataDiffService.diff(
      sourceSession.query, sourceSession.metadata, this.sourceDb,
      targetSession.query, this.targetDb,
      undefined,
      { sourceSchema: this.sourceSchema, targetSchema: this.targetSchema },
    );
  }

  private async loadDiff(): Promise<void> {
    try {
      const diff = await this.computeDiff();
      this.post({ type: 'diff', diff });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (DataDiffView.current === this) DataDiffView.current = undefined;
    this.manager.release(this.sourceConn.id);
    this.manager.release(this.targetConn.id);
  }
}