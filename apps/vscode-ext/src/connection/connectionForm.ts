import * as vscode from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import { ConnectionFactory, RedisClient, buildRedisTlsOptions } from '@devbelt/db-core';
import type { IConnection } from '@devbelt/db-core';
import { ConnectionStore, stripSecrets, type SavedConnection, type ConnectionGroup } from '@devbelt/db-host/connection/connectionStore';
import { SshTunnel } from './sshTunnel';
import { validateConnectionPaths } from './connectionPathValidator';
import { l10n } from '../i18n';
import { uniqueId } from '@devbelt/db-host/utils/id';
import { flattenGroups } from '../utils/groupTree';
import { BaseWebView } from '../result/baseWebView';

/**
 * 连接表单 webview（Vue 3 模式）。
 *
 * 提供类似 Navicat / database-client 的连接编辑界面：
 *  - 顶部选择数据库类型
 *  - 表单字段：名称、主机、端口、用户、密码、数据库、分组
 *  - 底部：测试连接、保存
 *
 * 通过 postMessage 与 Vue 视图通信：
 *  - webview → 扩展：{"type":"test","payload":{...}} / {"type":"save","payload":{...}}
 *  - 扩展 → webview：init / prefill / reset / presetGroup / testResult
 */
export class ConnectionForm extends BaseWebView {
  private static current?: ConnectionForm;
  private groups: ConnectionGroup[];
  private editing?: SavedConnection;
  private presetGroupId?: string;
  private onSaved?: () => void;

  private constructor(
    private readonly store: ConnectionStorage,
    groups: ConnectionGroup[],
    onSaved?: () => void,
    editing?: SavedConnection,
    presetGroupId?: string,
    private resolveEffective?: (conn: SavedConnection) => SavedConnection,
  ) {
    super('devbelt.connectionForm', editing ? 'Edit Connection' : 'New Connection');
    this.groups = groups;
    this.onSaved = onSaved;
    this.editing = editing;
    this.presetGroupId = presetGroupId;
  }

  /** 打开连接表单（单例复用），可预设分组或编辑已有连接 */
  static open(
    store: ConnectionStorage,
    onSaved?: () => void,
    presetGroupId?: string,
    editing?: SavedConnection,
    resolveEffective?: (conn: SavedConnection) => SavedConnection,
  ): void {
    if (ConnectionForm.current) {
      ConnectionForm.current.panel.reveal(vscode.ViewColumn.Active);
      ConnectionForm.current.onSaved = onSaved;
      ConnectionForm.current.editing = editing;
      ConnectionForm.current.presetGroupId = presetGroupId;
      ConnectionForm.current.resolveEffective = resolveEffective;
      ConnectionForm.current.sendInit();
      return;
    }
    ConnectionForm.current = new ConnectionForm(store, store.getGroups(), onSaved, editing, presetGroupId, resolveEffective);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'ready') {
      this.sendInit();
      return;
    }
    try {
      switch (msg.type) {
        case 'test': {
          // 编辑连接时表单不回传未改动的密钥（留空=保留），测试需回退到已保存值。
          const conn = mergeSecretsFromStored(decodeConnection(msg.payload), this.editing);
          const okMsg = await this.testConnection(conn);
          this.post({ type: 'testResult', ...okMsg });
          break;
        }
        case 'save': {
          const conn = decodeConnection(msg.payload);
          const id = conn.id || uniqueId('c');
          await this.store.save({ ...conn, id });
          vscode.window.showInformationMessage(
            l10n('form.saved', { name: conn.name || conn.host || '' }),
          );
          this.onSaved?.();
          this.panel.dispose();
          break;
        }
      }
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (ConnectionForm.current === this) ConnectionForm.current = undefined;
  }

  private sendInit(): void {
    // 打开表单期间分组可能被别处增删：构造时缓存的分组会过期，下拉选项陈旧。
    // 发送前从存储重新读取。
    this.groups = this.store.getGroups();
    this.post({
      type: 'init',
      mode: 'connectionForm',
      groups: flattenGroups(this.groups).map(({ group, depth }) => ({ id: group.id, name: group.name, depth })),
    });
    if (this.editing) {
      this.post({ type: 'prefill', conn: stripSecrets(this.editing) });
    } else {
      this.post({ type: 'reset' });
    }
    if (this.presetGroupId) {
      this.post({ type: 'presetGroup', groupId: this.presetGroupId });
    }
  }

  private static testIdCounter = 0;

  /** 测试连接：用 db-core 工厂建连验证；SSH 配置时建临时隧道 */
  private async testConnection(conn: SavedConnection): Promise<{ ok: boolean; message: string }> {
    const dbType = conn.dbType as DatabaseType;
    const start = Date.now();
    const testId = `test-${Date.now()}-${++ConnectionForm.testIdCounter}`;
    let connection: IConnection | undefined;
    let effective = conn;
    try {
      // 用与真正建连相同的有效配置（本机路径覆盖优先）并做同样的路径硬校验：
      // 旧实现直接拿表单原始值建连，覆盖了路径/缺文件时「测试成功」而打开必然失败。
      effective = this.resolveEffective ? this.resolveEffective(conn) : conn;
      const pathCheck = await validateConnectionPaths(effective);
      if (!pathCheck.valid) {
        const fields = pathCheck.issues.map((i) => `${i.field}(${i.reason})`).join(', ');
        return { ok: false, message: l10n('sync.pathInvalid', { fields }) };
      }
      let host = effective.host;
      let port = effective.port;
      if (effective.sshHost) {
        const localPort = await SshTunnel.create({ ...effective, id: testId });
        if (localPort) { host = '127.0.0.1'; port = localPort; }
      }
      if (dbType === DatabaseType.REDIS) {
        // Redis：临时客户端 + PING 探活；SSH 隧道由上面的 SshTunnel 临时建连提供，
        // finally 统一关闭（与 SQL 分支同一套 testId 清理）。
        const client = new RedisClient({
          host,
          port,
          username: effective.user || undefined,
          password: effective.password,
          db: effective.redisDb,
          tls: effective.useSSL
            ? buildRedisTlsOptions({
                caPath: effective.caPath,
                clientCertPath: effective.clientCertPath,
                clientKeyPath: effective.clientKeyPath,
                rejectUnauthorized: effective.rejectUnauthorized,
                servername: effective.host,
              })
            : undefined,
          connectTimeout: effective.connectTimeout,
          readOnly: true,
        });
        try {
          await client.connect();
          await client.ping();
        } finally {
          await client.close();
        }
        const cost = Date.now() - start;
        return { ok: true, message: l10n('form.connected', { ms: cost }) };
      }
      const { connection: conn1 } = ConnectionFactory.createWithDialect(dbType, {
        ...effective,
        host,
        port,
      });
      connection = conn1;
      await new Promise<void>((resolve, reject) => {
        connection!.connect((err) => (err ? reject(err) : resolve()));
      });
      const cost = Date.now() - start;
      return { ok: true, message: l10n('form.connected', { ms: cost }) };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    } finally {
      connection?.end();
      if (effective.sshHost) SshTunnel.close(testId);
    }
  }
}

/** 连接存储接口（避免循环依赖具体类） */
interface ConnectionStorage {
  save(conn: SavedConnection): Promise<void>;
  getGroups(): ConnectionGroup[];
}

function defaultPort(dbType: DatabaseType): number {
  switch (dbType) {
    case DatabaseType.PG: return 5432;
    case DatabaseType.SQLITE: return 0;
    case DatabaseType.REDIS: return 6379;
    default: return 3306;
  }
}

/**
 * 表单未提交的敏感字段回退到已保存连接的值。
 *
 * webview 在编辑态对未改动的密钥「留空且不发送」（见 ConnectionFormView.collect）；
 * 因此测试连接时需用已存密钥补齐。显式清除会发送空串，此时 `''` 优先，不被覆盖。
 * 保存路径无需此合并：db-host 的 `sanitize` 对缺省字段保留、对 `''` 删除。
 */
export function mergeSecretsFromStored(decoded: SavedConnection, stored?: SavedConnection): SavedConnection {
  if (!stored) return decoded;
  const out = { ...decoded } as Record<string, unknown>;
  for (const field of ConnectionStore.SENSITIVE_FIELDS) {
    if (out[field] === undefined && stored[field] !== undefined) out[field] = stored[field];
  }
  return out as unknown as SavedConnection;
}

/** 将 webview 表单负载解码为 SavedConnection（导出供单测覆盖敏感字段三态） */
export function decodeConnection(payload: any): SavedConnection {
  return {
    id: payload.id ?? '',
    name: payload.name,
    dbType: payload.dbType as DatabaseType,
    host: payload.host,
    port: Number.isFinite(Number(payload.port)) ? Number(payload.port) : defaultPort(payload.dbType as DatabaseType),
    user: payload.user,
    password: payload.password,
    database: payload.database,
    schema: payload.schema || undefined,
    timezone: payload.timezone || undefined,
    sqliteCommand: payload.sqliteCommand || undefined,
    dbPath: payload.dbPath,
    groupId: payload.groupId || undefined,
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
    // 敏感字段原样透传：'' 表示「显式清除」，不能折叠成 undefined，否则 sanitize 的删除分支收不到。
    sshPassword: payload.sshPassword,
    sshPrivateKeyPath: payload.sshPrivateKeyPath || undefined,
    sshPassphrase: payload.sshPassphrase,
    // Redis（P7 S2）：ACL 用户名复用 user，密码复用 password；证书路径复用 caPath/clientCertPath/clientKeyPath。
    redisDb: payload.redisDb !== undefined && payload.redisDb !== '' && Number.isFinite(Number(payload.redisDb)) ? Number(payload.redisDb) : undefined,
    keySeparator: payload.keySeparator || undefined,
    redisMode: payload.redisMode || undefined,
    sentinelName: payload.sentinelName || undefined,
    sentinelPassword: payload.sentinelPassword,
    clusterNodes: payload.clusterNodes || undefined,
    sentinelNodes: payload.sentinelNodes || undefined,
    color: payload.color || undefined,
  };
}
