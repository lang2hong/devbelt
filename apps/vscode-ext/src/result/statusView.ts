import * as vscode from 'vscode';
import { DatabaseType } from '@devkit/db-core';
import type { SavedConnection } from '@devkit/db-host/connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { ensureWritable } from '../utils/sqlSafety';
import { AuditLogger } from '../utils/auditLogger';
import { l10n } from '../i18n';

export interface ServerSummary {
  dbType: string;
  version?: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  currentUser?: string;
}

export class StatusView extends BaseWebView {
  private static current?: StatusView;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
  ) {
    super('devbelt.serverStatus', `Status @ ${conn.name || conn.host}`);
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static open(conn: SavedConnection, manager: ConnectionManager): void {
    if (StatusView.current) StatusView.current.dispose();
    const view = new StatusView(conn, manager);
    StatusView.current = view;
  }


  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'killProcess') {
      const id = Number(msg.id);
      if (!Number.isFinite(id)) return;
      // 结束服务端进程是写操作：只读连接必须被拦截（此前直接放行）。
      if (!ensureWritable(this.conn)) return;
      const confirmed = await vscode.window.showWarningMessage(
        l10n('status.killConfirm', { id }), { modal: true }, l10n('status.kill'),
      );
      if (confirmed !== l10n('status.kill')) return;
      try {
        const session = await this.manager.connect(this.conn);
        const dbType = session.query.dialect.dbType;
        if (dbType === DatabaseType.PG) {
          await session.query.query(`SELECT pg_terminate_backend(${id}::int)`);
        } else if (dbType === DatabaseType.MYSQL) {
          await session.query.query(`KILL ${id}`);
        }
        // 记审计：结束进程是破坏性管理动作，此前无任何留痕。
        AuditLogger.tryLog({
          action: 'process_kill',
          connName: this.conn.name || this.conn.host,
          database: this.conn.database,
          sql: `kill ${id}`,
        });
        const processList = await session.metadata.getProcessList();
        this.post({ type: 'processList', processList });
      } catch (err) {
        this.post({ type: 'error', message: (err as Error).message });
      }
      return;
    }
    if (msg.type !== 'ready') return;
    if (!this.initSent) {
      // 第一次 ready 来自 App.vue 默认 QueryView：仅发 init 切到 status 模式，
      // 等 StatusView.vue 挂载后再查数据，避免 data 在监听器注册前发送丢失。
      this.initSent = true;
      this.post({ type: 'init', mode: 'status' });
      return;
    }
    // 第二次 ready 来自 StatusView.vue 挂载：查询并推送数据
    try {
      const session = await this.manager.connect(this.conn);
      const [processList, statusVars, serverVars, summary] = await Promise.all([
        session.metadata.getProcessList(),
        session.metadata.getStatusVariables(),
        session.metadata.getServerVariables(),
        this.querySummary(session as any),
      ]);
      this.post({ type: 'data', processList, statusVars, serverVars, summary });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async querySummary(session: any): Promise<ServerSummary> {
    const dbType = session.query.dialect.dbType;
    const conn = this.conn;
    const summary: ServerSummary = { dbType, host: conn.host, port: conn.port, user: conn.user, database: conn.database };
    try {
      if (dbType === DatabaseType.MYSQL) {
        const r = await session.query.query('SELECT VERSION() AS v, DATABASE() AS d, CURRENT_USER() AS u');
        const row = r.rows[0] as any;
        summary.version = row?.v; summary.database = row?.d ?? conn.database; summary.currentUser = row?.u;
      } else if (dbType === DatabaseType.PG) {
        const r = await session.query.query('SELECT version() AS v, current_user AS u, current_database() AS d');
        const row = r.rows[0] as any;
        summary.version = row?.v; summary.database = row?.d ?? conn.database; summary.currentUser = row?.u;
      } else {
        const r = await session.query.query('select sqlite_version() AS v');
        summary.version = (r.rows[0] as any)?.v;
      }
    } catch { /* 省略，概要可选 */ }
    return summary;
  }

  protected onDispose(): void {
    super.onDispose();
    if (StatusView.current === this) StatusView.current = undefined;
    if (!this.manager.isExplicit(this.conn.id)) {
      this.manager.disposeConn(this.conn.id);
    }
  }
}
