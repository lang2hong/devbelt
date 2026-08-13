import { DataDiffService, type DataDiffResult } from '@db-client/core';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';

export class DataDiffView extends BaseWebView {
  private static current?: DataDiffView;

  private constructor(
    private readonly sourceConn: SavedConnection,
    private readonly sourceDb: string,
    private readonly targetConn: SavedConnection,
    private readonly targetDb: string,
    private readonly manager: ConnectionManager,
  ) {
    super('dbclient.dataDiff', `Data Diff: ${sourceDb} → ${targetDb}`);
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
        const session = await this.manager.connect(this.targetConn);
        const diff = await this.computeDiff();
        const sql = DataDiffService.generateSyncSql(diff, this.targetDb, session.query);
        await session.query.query(sql);
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
  }
}