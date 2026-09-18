import { DataDiffService, type DataDiffResult } from '@devkit/db-core';
import type { SavedConnection } from '@devkit/db-host/connection/connectionStore';
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
  ) {
    super('devbelt.dataDiff', `Data Diff: ${sourceDb} → ${targetDb}`);
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static async open(
    sourceConn: SavedConnection,
    sourceDb: string,
    targetConn: SavedConnection,
    targetDb: string,
    manager: ConnectionManager,
  ): Promise<void> {
    if (DataDiffView.current) DataDiffView.current.dispose();
    const view = new DataDiffView(sourceConn, sourceDb, targetConn, targetDb, manager);
    DataDiffView.current = view;
  }

  private initSent = false;

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
        const session = await this.manager.connect(this.targetConn);
        const sql = DataDiffService.generateSyncSql(diff, this.targetDb, session.query);
        // 破坏性 DML：先经只读/生产/高危确认门禁，再执行并审计。
        if (!(await confirmSqlExecution(this.targetConn, sql))) {
          this.post({ type: 'error', message: l10n('transfer.cancelled') });
          return;
        }
        const started = Date.now();
        await session.query.query(sql);
        AuditLogger.tryLog({
          action: 'data_sync',
          connName: this.targetConn.name || this.targetConn.host,
          database: this.targetDb,
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
    const sourceSession = await this.manager.connect(this.sourceConn);
    const targetSession = await this.manager.connect(this.targetConn);
    return DataDiffService.diff(
      sourceSession.query, sourceSession.metadata, this.sourceDb,
      targetSession.query, this.targetDb,
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
    if (!this.manager.isExplicit(this.sourceConn.id)) {
      this.manager.disposeConn(this.sourceConn.id);
    }
    if (!this.manager.isExplicit(this.targetConn.id)) {
      this.manager.disposeConn(this.targetConn.id);
    }
  }
}