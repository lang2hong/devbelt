import { DatabaseType } from '@devkit/db-core';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';

interface MetricPoint {
  time: number;
  value: number;
}

interface DashboardData {
  summary: {
    dbType: string;
    version?: string;
    host?: string;
    port?: number;
    currentUser?: string;
    database?: string;
  };
  metrics: {
    activeConnections: MetricPoint[];
    questions: MetricPoint[];
    slowQueries: MetricPoint[];
    bytesReceived: MetricPoint[];
    bytesSent: MetricPoint[];
  };
  processList: any[];
  keyVars: { label: string; value: string }[];
}

const MAX_POINTS = 60;
const COLLECT_INTERVAL_MS = 5000;

export class DashboardView extends BaseWebView {
  private static current?: DashboardView;
  private collectTimer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private history: DashboardData['metrics'] = {
    activeConnections: [],
    questions: [],
    slowQueries: [],
    bytesReceived: [],
    bytesSent: [],
  };

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
  ) {
    super('dbclient.dashboard', `Dashboard @ ${conn.name || conn.host}`);
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static open(conn: SavedConnection, manager: ConnectionManager): void {
    if (DashboardView.current) DashboardView.current.dispose();
    const view = new DashboardView(conn, manager);
    DashboardView.current = view;
  }

  private initSent = false;

  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type !== 'ready') return;
    if (!this.initSent) {
      this.initSent = true;
      this.post({ type: 'init', mode: 'dashboard' });
      return;
    }
    this.startCollecting();
    await this.collectAndSend();
  }

  private startCollecting(): void {
    if (this.collectTimer) return;
    this.collectTimer = setInterval(() => {
      void this.collectAndSend();
    }, COLLECT_INTERVAL_MS);
  }

  private async collectAndSend(): Promise<void> {
    if (this.disposed) return;
    try {
      const session = await this.manager.connect(this.conn);
      const [processList, statusVars, serverVars, summary] = await Promise.all([
        session.metadata.getProcessList(),
        session.metadata.getStatusVariables(),
        session.metadata.getServerVariables(),
        this.querySummary(session as any),
      ]);

      const varMap = this.flattenVars(serverVars, statusVars);
      const now = Date.now();

      this.pushPoint(this.history.activeConnections, now, this.getNumber(varMap, 'threads_connected'));
      this.pushPoint(this.history.questions, now, this.getNumber(varMap, 'questions'));
      this.pushPoint(this.history.slowQueries, now, this.getNumber(varMap, 'slow_queries'));
      this.pushPoint(this.history.bytesReceived, now, this.getNumber(varMap, 'bytes_received'));
      this.pushPoint(this.history.bytesSent, now, this.getNumber(varMap, 'bytes_sent'));

      const keyVarDefs = [
        { label: 'Version', key: 'version' },
        { label: 'Charset', key: 'character_set_server' },
        { label: 'Collation', key: 'collation_server' },
        { label: 'Timezone', key: 'time_zone' },
        { label: 'Max Connections', key: 'max_connections' },
        { label: 'Active Threads', key: 'threads_connected' },
        { label: 'Threads Running', key: 'threads_running' },
        { label: 'Uptime (s)', key: 'uptime' },
        { label: 'Slow Queries', key: 'slow_queries' },
        { label: 'QPS', key: 'questions' },
        { label: 'Engine', key: 'default_storage_engine' },
        { label: 'Hostname', key: 'hostname' },
      ];

      const data: DashboardData = {
        summary,
        metrics: this.history,
        processList,
        keyVars: keyVarDefs
          .map((d) => ({ ...d, value: varMap.get(d.key.toLowerCase()) || '' }))
          .filter((d) => d.value),
      };
      this.post({ type: 'data', ...data });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private pushPoint(arr: MetricPoint[], time: number, value: number): void {
    arr.push({ time, value });
    if (arr.length > MAX_POINTS) arr.shift();
  }

  private getNumber(varMap: Map<string, string>, key: string): number {
    const v = varMap.get(key.toLowerCase());
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  private flattenVars(serverVars: any[], statusVars: any[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const rows of [serverVars, statusVars]) {
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const keys = Object.keys(r);
        const k = String(r.Variable_name ?? r.name ?? keys[0] ?? '');
        const v = r.Value ?? r.value ?? (keys.length > 1 ? r[keys[1]] : r[keys[0]]);
        if (k) m.set(k.toLowerCase(), String(v ?? ''));
      }
    }
    return m;
  }

  private async querySummary(session: any): Promise<DashboardData['summary']> {
    const dbType = session.query.dialect.dbType;
    const conn = this.conn;
    const summary: DashboardData['summary'] = { dbType, host: conn.host, port: conn.port, currentUser: conn.user, database: conn.database };
    try {
      if (dbType === DatabaseType.MYSQL) {
        const r = await session.query.query('SELECT VERSION() AS v, CURRENT_USER() AS u');
        const row = r.rows[0] as any;
        summary.version = row?.v; summary.currentUser = row?.u;
      } else if (dbType === DatabaseType.PG) {
        const r = await session.query.query('SELECT version() AS v, current_user AS u');
        const row = r.rows[0] as any;
        summary.version = row?.v; summary.currentUser = row?.u;
      } else {
        const r = await session.query.query('select sqlite_version() AS v');
        summary.version = (r.rows[0] as any)?.v;
      }
    } catch { /* 概要可选 */ }
    return summary;
  }

  protected onDispose(): void {
    super.onDispose();
    this.disposed = true;
    if (this.collectTimer) { clearInterval(this.collectTimer); this.collectTimer = undefined; }
    if (DashboardView.current === this) DashboardView.current = undefined;
    if (!this.manager.isExplicit(this.conn.id)) {
      this.manager.disposeConn(this.conn.id);
    }
  }
}