import * as vscode from 'vscode';
import { DatabaseType } from '@db-client/core';
import { ConnectionFactory } from '@db-client/core';
import type { SavedConnection } from './connectionStore';
import { isZh, l10n } from '../i18n';

/**
 * 连接表单 webview。
 *
 * 提供类似 Navicat / database-client 的连接编辑界面：
 *  - 顶部选择数据库类型
 *  - 表单字段：名称、主机、端口、用户、密码、数据库
 *  - 底部：测试连接、保存
 *
 * 通过 postMessage 与扩展通信：
 *  - webview → 扩展：{"type":"test","payload":{...}} / {"type":"save","payload":{...}}
 *  - 扩展 → webview：{"type":"testResult","ok":bool,"message":string}
 */
export class ConnectionForm {
  private static current?: ConnectionForm;
  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly store: ConnectionStorage,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dbclient.connectionForm',
      'New Connection',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = connectionFormHtml();
    // 告知 webview 当前语言，用于文案切换
    void this.panel.webview.postMessage({ type: 'locale', isZh: isZh() });

    // 处理 webview 发来的消息
    this.panel.webview.onDidReceiveMessage((msg) => {
      void this.handleMessage(msg);
    });

    this.panel.onDidDispose(() => {
      if (ConnectionForm.current === this) ConnectionForm.current = undefined;
    });
  }

  /** 打开连接表单（单例复用） */
  static open(store: ConnectionStorage): void {
    if (ConnectionForm.current) {
      ConnectionForm.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    ConnectionForm.current = new ConnectionForm(store);
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'test': {
        const conn = decodeConnection(msg.payload);
        const okMsg = await this.testConnection(conn);
        void this.panel.webview.postMessage({ type: 'testResult', ...okMsg });
        break;
      }
      case 'save': {
        const conn = decodeConnection(msg.payload);
        const id = msg.payload.id || `${Date.now()}`;
        await this.store.save({ ...conn, id, groupId: msg.payload.groupId });
        vscode.window.showInformationMessage(
          l10n('form.saved', { name: conn.name || conn.host || '' }),
        );
        this.panel.dispose();
        break;
      }
    }
  }

  /** 测试连接：用 db-core 工厂建连验证 */
  private async testConnection(conn: SavedConnection): Promise<{ ok: boolean; message: string }> {
    const dbType = conn.dbType as DatabaseType;
    const start = Date.now();
    try {
      const { connection } = ConnectionFactory.createWithDialect(dbType, conn);
      await new Promise<void>((resolve, reject) => {
        connection.connect((err) => (err ? reject(err) : resolve()));
      });
      const cost = Date.now() - start;
      connection.end();
      return { ok: true, message: l10n('form.connected', { ms: cost }) };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

/** 连接存储接口（避免循环依赖具体类） */
interface ConnectionStorage {
  save(conn: SavedConnection): Promise<void>;
}

/** 将 webview 表单负载解码为 SavedConnection */
function decodeConnection(payload: any): SavedConnection {
  return {
    id: payload.id || '',
    name: payload.name,
    dbType: payload.dbType as DatabaseType,
    host: payload.host,
    port: Number(payload.port),
    user: payload.user,
    password: payload.password,
    database: payload.database,
    dbPath: payload.dbPath,
  };
}

/** 生成连接表单 HTML */
function connectionFormHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); padding: 16px 20px; color: var(--vscode-foreground); }
  h2 { margin: 0 0 16px; font-size: 16px; }
  .field { margin-bottom: 12px; }
  label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
  input, select {
    width: 100%; box-sizing: border-box; padding: 6px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
  }
  .row { display: flex; gap: 12px; }
  .row .field { flex: 1; }
  .actions { margin-top: 20px; display: flex; gap: 8px; }
  button {
    padding: 6px 16px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #status { margin-top: 12px; font-size: 12px; min-height: 16px; }
  #status.ok { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  #status.err { color: var(--vscode-errorForeground); }
  #dbPathRow { display: none; }
</style>
</head>
<body>
  <h2 data-i18n="title">New Connection</h2>
  <div class="field">
    <label data-i18n="dbType">Database Type</label>
    <select id="dbType">
      <option value="MYSQL" selected>MySQL</option>
      <option value="PG">PostgreSQL</option>
      <option value="SQLITE">SQLite</option>
    </select>
  </div>
  <div class="field">
    <label data-i18n="name">Name</label>
    <input id="name" placeholder="My Database">
  </div>
  <div class="row">
    <div class="field">
      <label data-i18n="host">Host</label>
      <input id="host" value="localhost">
    </div>
    <div class="field">
      <label data-i18n="port">Port</label>
      <input id="port" value="3306">
    </div>
  </div>
  <div class="row">
    <div class="field">
      <label data-i18n="user">User</label>
      <input id="user" value="root">
    </div>
    <div class="field">
      <label data-i18n="password">Password</label>
      <input id="password" type="password">
    </div>
  </div>
  <div class="field">
    <label data-i18n="database">Database</label>
    <input id="database" placeholder="default">
  </div>
  <div class="field" id="dbPathRow">
    <label data-i18n="sqlitePath">SQLite File Path</label>
    <input id="dbPath" placeholder="/path/to/db.sqlite">
  </div>
  <div class="actions">
    <button id="btnTest" class="secondary" data-i18n="test">Test Connection</button>
    <button id="btnSave" data-i18n="save">Save</button>
  </div>
  <div id="status"></div>

<script>
  const vscode = acquireVsCodeApi();
  // 中英文案表（未收到 locale 消息时默认为英文）
  const I18N = {
    title: { en: 'New Connection', zh: '新建连接' },
    dbType: { en: 'Database Type', zh: '数据库类型' },
    name: { en: 'Name', zh: '名称' },
    host: { en: 'Host', zh: '主机' },
    port: { en: 'Port', zh: '端口' },
    user: { en: 'User', zh: '用户' },
    password: { en: 'Password', zh: '密码' },
    database: { en: 'Database', zh: '数据库' },
    sqlitePath: { en: 'SQLite File Path', zh: 'SQLite 文件路径' },
    test: { en: 'Test Connection', zh: '测试连接' },
    save: { en: 'Save', zh: '保存' },
    testing: { en: 'Testing...', zh: '测试中...' },
  };
  let isZh = false;
  function applyLocale() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const entry = I18N[key];
      if (entry) el.textContent = isZh ? entry.zh : entry.en;
    });
  }
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'locale') { isZh = msg.isZh; applyLocale(); }
    if (msg.type === 'testResult') {
      const status = document.getElementById('status');
      status.className = msg.ok ? 'ok' : 'err';
      status.textContent = msg.message;
    }
  });

  const dbType = document.getElementById('dbType');
  const dbPathRow = document.getElementById('dbPathRow');
  const hostRow = document.getElementById('host').closest('.row');

  function syncType() {
    const t = dbType.value;
    const isSqlite = t === 'SQLITE';
    dbPathRow.style.display = isSqlite ? 'block' : 'none';
    hostRow.style.display = isSqlite ? 'none' : 'flex';
    document.getElementById('port').value = t === 'PG' ? '5432' : '3306';
    if (isSqlite) document.getElementById('host').value = '';
  }
  dbType.addEventListener('change', syncType);
  syncType();

  function collect() {
    return {
      dbType: dbType.value,
      name: document.getElementById('name').value,
      host: document.getElementById('host').value,
      port: document.getElementById('port').value,
      user: document.getElementById('user').value,
      password: document.getElementById('password').value,
      database: document.getElementById('database').value,
      dbPath: document.getElementById('dbPath').value,
    };
  }

  document.getElementById('btnTest').addEventListener('click', () => {
    const status = document.getElementById('status');
    status.className = '';
    status.textContent = isZh ? I18N.testing.zh : I18N.testing.en;
    vscode.postMessage({ type: 'test', payload: collect() });
  });

  document.getElementById('btnSave').addEventListener('click', () => {
    vscode.postMessage({ type: 'save', payload: collect() });
  });
</script>
</body>
</html>`;
}