import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';

export class StatusView extends BaseWebView {
  private static current?: StatusView;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
  ) {
    super('dbclient.serverStatus', `Status @ ${conn.name || conn.host}`);
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static open(conn: SavedConnection, manager: ConnectionManager): void {
    if (StatusView.current) StatusView.current.dispose();
    const view = new StatusView(conn, manager);
    StatusView.current = view;
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type !== 'ready') return;
    try {
      const session = await this.manager.connect(this.conn);
      const [processList, statusVars, serverVars] = await Promise.all([
        session.metadata.getProcessList(),
        session.metadata.getStatusVariables(),
        session.metadata.getServerVariables(),
      ]);
      this.post({ type: 'data', processList, statusVars, serverVars });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (StatusView.current === this) StatusView.current = undefined;
  }
}
