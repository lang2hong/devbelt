import * as vscode from 'vscode';
import { DatabaseType } from '@db-client/core';
import { ConnectionFactory } from '@db-client/core';
import type { SavedConnection, ConnectionGroup } from './connectionStore';
import { isZh, l10n } from '../i18n';

/**
 * 连接表单 webview。
 *
 * 提供类似 Navicat / database-client 的连接编辑界面：
 *  - 顶部选择数据库类型
 *  - 表单字段：名称、主机、端口、用户、密码、数据库、分组
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
    groups: ConnectionGroup[],
    private onSaved?: () => void,
    editing?: SavedConnection,
  ) {
    const title = editing ? 'Edit Connection' : 'New Connection';
    this.panel = vscode.window.createWebviewPanel(
      'dbclient.connectionForm',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = connectionFormHtml(groups);
    void this.panel.webview.postMessage({ type: 'locale', isZh: isZh() });
    if (editing) {
      void this.panel.webview.postMessage({ type: 'prefill', conn: editing });
    }
    const msgDisp = this.panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      msgDisp.dispose();
      if (ConnectionForm.current === this) ConnectionForm.current = undefined;
    });
  }

  /** 打开连接表单（单例复用），可预设分组或编辑已有连接 */
  static open(
    store: ConnectionStorage,
    onSaved?: () => void,
    presetGroupId?: string,
    editing?: SavedConnection,
  ): void {
    if (ConnectionForm.current) {
      ConnectionForm.current.panel.reveal(vscode.ViewColumn.Active);
      ConnectionForm.current.onSaved = onSaved;
      return;
    }
    ConnectionForm.current = new ConnectionForm(store, store.getGroups(), onSaved, editing);
    if (presetGroupId) {
      void ConnectionForm.current.panel.webview.postMessage({ type: 'presetGroup', groupId: presetGroupId });
    }
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
        await this.store.save({
          ...conn,
          id,
          groupId: msg.payload.groupId || undefined,
        });
        vscode.window.showInformationMessage(
          l10n('form.saved', { name: conn.name || conn.host || '' }),
        );
        this.onSaved?.();
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
  getGroups(): ConnectionGroup[];
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
    environment: payload.environment || 'development',
    readOnly: Boolean(payload.readOnly),
    useConnectionString: Boolean(payload.useConnectionString),
    connectionUrl: payload.connectionUrl || undefined,
    useSSL: Boolean(payload.useSSL),
    caPath: payload.caPath || undefined,
    clientCertPath: payload.clientCertPath || undefined,
    clientKeyPath: payload.clientKeyPath || undefined,
    socketPath: payload.socketPath || undefined,
    connectTimeout: payload.connectTimeout ? Number(payload.connectTimeout) : undefined,
    requestTimeout: payload.requestTimeout ? Number(payload.requestTimeout) : undefined,
    sshHost: payload.sshHost || undefined,
    sshPort: payload.sshPort ? Number(payload.sshPort) : undefined,
    sshUser: payload.sshUser || undefined,
    sshPassword: payload.sshPassword || undefined,
    sshPrivateKeyPath: payload.sshPrivateKeyPath || undefined,
    sshPassphrase: payload.sshPassphrase || undefined,
  };
}

/**
 * 将分组构建为带层级缩进的下拉选项，模拟树形结构。
 * 顶层分组无前缀，子分组按深度用 "· " 缩进。
 */
function buildGroupOptions(groups: ConnectionGroup[]): string {
  const byParent = new Map<string | undefined, ConnectionGroup[]>();
  for (const g of groups) {
    const key = g.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(g);
  }
  const options: string[] = [];
  const walk = (parentId: string | undefined, depth: number) => {
    const children = byParent.get(parentId) || [];
    for (const g of children) {
      const indent = depth === 0 ? '' : '· '.repeat(depth);
      options.push(`<option value="${g.id}">${indent}${g.name}</option>`);
      walk(g.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return options.join('');
}

/** 生成连接表单 HTML */
function connectionFormHtml(groups: ConnectionGroup[]): string {
  const groupOptions = buildGroupOptions(groups);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); margin: 0; padding: 0; color: var(--vscode-foreground); }
  .container {
    max-width: 480px; margin: 40px auto; padding: 24px 28px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
    border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }
  h2 { margin: 0 0 20px; font-size: 18px; font-weight: 600; }
  .field { margin-bottom: 14px; }
  label { display: block; font-size: 12px; margin-bottom: 5px; color: var(--vscode-descriptionForeground); font-weight: 500; }
  input, select {
    width: 100%; box-sizing: border-box; padding: 7px 10px; font-size: 13px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); border-radius: 4px;
    transition: border-color 0.15s;
  }
  input:focus, select:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .row { display: flex; gap: 12px; }
  .row .field { flex: 1; }
  .pw { display: flex; gap: 6px; align-items: center; }
  .pw input { flex: 1; }
  .pw .toggle { flex: 0 0 auto; padding: 7px 10px; cursor: pointer; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); font-size: 12px; }
  .pw .toggle:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions { margin-top: 24px; display: flex; gap: 10px; }
  button {
    flex: 1; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;
    font-size: 13px; font-weight: 500;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #status { margin-top: 14px; font-size: 12px; min-height: 18px; }
  #status.ok { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  #status.err { color: var(--vscode-errorForeground); }
  #dbPathRow { display: none; }
</style>
</head>
<body>
  <div class="container">
  <span id="editorMode" style="display:none"></span>
  <h2 data-i18n="title">New Connection</h2>
  <div class="field">
    <label data-i18n="dbType">Database Type</label>
    <select id="dbType">
      <option value="MYSQL" selected>MySQL</option>
      <option value="PG">PostgreSQL</option>
      <option value="SQLITE">SQLite</option>
    </select>
  </div>
  <div class="row">
    <div class="field">
      <label data-i18n="name">Name</label>
      <input id="name" placeholder="My Database">
    </div>
    <div class="field">
      <label data-i18n="group">Group</label>
      <select id="group">
        <option value="" selected data-i18n="noGroup">No group</option>
        ${groupOptions}
      </select>
    </div>
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
      <div class="pw">
        <input id="password" type="password">
        <button type="button" class="toggle" data-target="password" data-i18n="show">Show</button>
      </div>
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
  <details class="ssh-section">
     <summary data-i18n="ssh">SSH Tunnel (optional)</summary>
     <div class="field"><label data-i18n="sshHost">SSH Host</label><input id="sshHost" type="text" placeholder="192.168.1.1"></div>
     <div class="field"><label data-i18n="sshPort">SSH Port</label><input id="sshPort" type="number" value="22"></div>
     <div class="field"><label data-i18n="sshUser">SSH User</label><input id="sshUser" type="text" placeholder="root"></div>
     <div class="field"><label data-i18n="sshPass">SSH Password</label><div class="pw"><input id="sshPassword" type="password"><button type="button" class="toggle" data-target="sshPassword" data-i18n="show">Show</button></div></div>
     <div class="field"><label data-i18n="sshKey">SSH Private Key Path</label><input id="sshPrivateKeyPath" type="text" placeholder="~/.ssh/id_rsa"></div>
     <div class="field"><label data-i18n="sshPhrase">SSH Key Passphrase</label><div class="pw"><input id="sshPassphrase" type="password"><button type="button" class="toggle" data-target="sshPassphrase" data-i18n="show">Show</button></div></div>
   </details>
   <details class="ssh-section">
     <summary>Advanced Connection Settings</summary>
     <div class="row">
       <div class="field"><label>Environment</label><select id="environment"><option value="development">Development</option><option value="test">Test</option><option value="staging">Staging</option><option value="production">Production</option></select></div>
       <div class="field"><label>Access</label><label><input id="readOnly" type="checkbox" style="width:auto"> Read-only</label></div>
     </div>
     <div class="field"><label><input id="useConnectionString" type="checkbox" style="width:auto"> Use connection URL</label><input id="connectionUrl" placeholder="mysql://user:password@host:3306/database"></div>
     <div class="field"><label><input id="useSSL" type="checkbox" style="width:auto"> Use SSL/TLS</label></div>
     <div class="field"><label>CA certificate path</label><input id="caPath" placeholder="/path/to/ca.pem"></div>
     <div class="row">
       <div class="field"><label>Client certificate path</label><input id="clientCertPath" placeholder="/path/to/client.crt"></div>
       <div class="field"><label>Client key path</label><input id="clientKeyPath" placeholder="/path/to/client.key"></div>
     </div>
     <div class="row">
       <div class="field"><label>Connect timeout (ms)</label><input id="connectTimeout" type="number" value="5000"></div>
       <div class="field"><label>Request timeout (ms)</label><input id="requestTimeout" type="number" value="30000"></div>
     </div>
     <div class="field"><label>Socket path</label><input id="socketPath" placeholder="/var/run/mysqld/mysqld.sock"></div>
   </details>
   <div class="actions">
     <button id="btnTest" class="secondary" data-i18n="test">Test Connection</button>
     <button id="btnSave" data-i18n="save">Save</button>
   </div>
   <div id="status"></div>
   </div>

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
    group: { en: 'Group', zh: '分组' },
    noGroup: { en: 'No group', zh: '无分组' },
    test: { en: 'Test Connection', zh: '测试连接' },
    save: { en: 'Save', zh: '保存' },
    testing: { en: 'Testing...', zh: '测试中...' },
    show: { en: 'Show', zh: '显示' },
    hide: { en: 'Hide', zh: '隐藏' },
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
    if (msg.type === 'presetGroup' && msg.groupId) {
      document.getElementById('group').value = msg.groupId;
    }
    if (msg.type === 'prefill' && msg.conn) {
      const c = msg.conn;
      document.getElementById('name').value = c.name || '';
      document.getElementById('host').value = c.host || '';
      document.getElementById('port').value = c.port || '';
      document.getElementById('user').value = c.user || '';
      document.getElementById('password').value = c.password || '';
      document.getElementById('database').value = c.database || '';
      document.getElementById('dbPath').value = c.dbPath || '';
      if (c.dbType) document.getElementById('dbType').value = c.dbType;
       if (c.groupId) document.getElementById('group').value = c.groupId;
       document.getElementById('environment').value = c.environment || 'development';
       document.getElementById('readOnly').checked = !!c.readOnly;
       document.getElementById('useConnectionString').checked = !!c.useConnectionString;
       document.getElementById('connectionUrl').value = c.connectionUrl || '';
       document.getElementById('useSSL').checked = !!c.useSSL;
       document.getElementById('caPath').value = c.caPath || '';
       document.getElementById('clientCertPath').value = c.clientCertPath || '';
       document.getElementById('clientKeyPath').value = c.clientKeyPath || '';
       document.getElementById('connectTimeout').value = c.connectTimeout || 5000;
       document.getElementById('requestTimeout').value = c.requestTimeout || 30000;
       document.getElementById('socketPath').value = c.socketPath || '';
      // 编辑模式标记，保存时携带原 id
      document.getElementById('editorMode').dataset.connId = c.id || '';
      document.querySelector('h2').textContent = isZh ? '编辑连接' : 'Edit Connection';
    }
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

  // 显示/隐藏密码切换
  document.querySelectorAll('.toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target || '');
      if (!target) return;
      const showing = target.type === 'text';
      target.type = showing ? 'password' : 'text';
      btn.textContent = isZh ? (showing ? I18N.show.zh : I18N.hide.zh) : (showing ? I18N.show.en : I18N.hide.en);
      applyLocale();
    });
  });

  function collect() {
    const editorEl = document.getElementById('editorMode');
    return {
      id: editorEl ? editorEl.dataset.connId || '' : '',
      dbType: dbType.value,
      name: document.getElementById('name').value,
      host: document.getElementById('host').value,
      port: document.getElementById('port').value,
      user: document.getElementById('user').value,
      password: document.getElementById('password').value,
      database: document.getElementById('database').value,
      dbPath: document.getElementById('dbPath').value,
       groupId: document.getElementById('group').value,
       environment: document.getElementById('environment').value,
       readOnly: document.getElementById('readOnly').checked,
       useConnectionString: document.getElementById('useConnectionString').checked,
       connectionUrl: document.getElementById('connectionUrl').value,
       useSSL: document.getElementById('useSSL').checked,
       caPath: document.getElementById('caPath').value,
       clientCertPath: document.getElementById('clientCertPath').value,
       clientKeyPath: document.getElementById('clientKeyPath').value,
       connectTimeout: document.getElementById('connectTimeout').value,
       requestTimeout: document.getElementById('requestTimeout').value,
       socketPath: document.getElementById('socketPath').value,
      sshHost: document.getElementById('sshHost').value,
      sshPort: document.getElementById('sshPort').value,
      sshUser: document.getElementById('sshUser').value,
      sshPassword: document.getElementById('sshPassword').value,
      sshPrivateKeyPath: document.getElementById('sshPrivateKeyPath').value,
      sshPassphrase: document.getElementById('sshPassphrase').value,
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
