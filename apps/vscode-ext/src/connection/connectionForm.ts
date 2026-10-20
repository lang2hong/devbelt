import * as vscode from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import { ConnectionFactory, EsClient, RedisClient, buildRedisTlsOptions, parseEsError } from '@devbelt/db-core';
import type { IConnection, RedisClientOptions } from '@devbelt/db-core';
import { ConnectionStore, type SavedConnection, type ConnectionGroup } from '@devbelt/db-host/connection/connectionStore';
import { sanitizeConnectionForExport } from '../utils/connectionExport';
import { SshTunnel } from './sshTunnel';
import { parseRedisNodes } from './buildRedisSession';
import { discoverSentinelMasterOverSsh, setupClusterOverSsh, type RedisAuth } from './redisTunnel';
import { esAuthMissingMessage, esAuthOf, esProtocolOf, esTlsOf } from './esAuth';
import { validateConnectionPaths } from './connectionPathValidator';
import { l10n } from '../i18n';
import { uniqueId } from '@devbelt/db-host/utils/id';
import { flattenGroups } from '../utils/groupTree';
import { BaseWebView } from '../result/baseWebView';

/**
 * 测试连接的公共 Redis 选项与隧道探测认证（与运行时会话装配 buildRedisSession 同源语义）。
 * `readOnly` 恒 true（测试只做 PING 探活，不写）。
 */
function redisTestCommon(conn: SavedConnection): { common: Omit<RedisClientOptions, 'host' | 'port' | 'db' | 'cluster' | 'sentinels' | 'sentinelName' | 'sentinelPassword'>; auth: RedisAuth } {
  const mode = conn.redisMode ?? 'standalone';
  const tls = conn.useSSL
    ? buildRedisTlsOptions({
        caPath: conn.caPath,
        clientCertPath: conn.clientCertPath,
        clientKeyPath: conn.clientKeyPath,
        rejectUnauthorized: conn.rejectUnauthorized,
        // sentinel 模式：ioredis 会把 tls 应用到解析出的 master，servername 留空避免用 sentinel 主机名校验 master。
        servername: mode === 'sentinel' ? undefined : conn.host,
      })
    : undefined;
  const common = {
    username: conn.user || undefined,
    password: conn.password,
    tls,
    connectTimeout: conn.connectTimeout,
    commandTimeout: conn.requestTimeout,
    readOnly: true,
  };
  const auth: RedisAuth = {
    username: conn.user || undefined,
    password: conn.password,
    sentinelPassword: conn.sentinelPassword,
    tls,
    connectTimeout: conn.connectTimeout,
  };
  return { common, auth };
}

/**
 * 测试连接的 Redis 选项（按模式分派；仅非 SSH 场景；SSH 分支在 testConnection 中叠加隧道）。
 * 与 buildRedisSession 的部署语义一致：cluster 用 clusterNodes、sentinel 用 sentinelNodes + master 名。
 */
export function redisTestClientOptions(conn: SavedConnection, host: string, port: number): RedisClientOptions {
  const { common } = redisTestCommon(conn);
  const mode = conn.redisMode ?? 'standalone';
  if (mode === 'cluster') {
    return {
      ...common,
      cluster: { nodes: parseRedisNodes(conn.clusterNodes, host, port), slotsRefreshTimeout: conn.connectTimeout ?? 3000 },
    };
  }
  if (mode === 'sentinel') {
    if (!conn.sentinelName) throw new Error('Redis Sentinel master 名称未配置');
    return {
      ...common,
      sentinels: parseRedisNodes(conn.sentinelNodes, host, port),
      sentinelName: conn.sentinelName,
      sentinelPassword: conn.sentinelPassword,
      db: conn.redisDb,
    };
  }
  return { ...common, host, port, db: conn.redisDb };
}

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
          // URL 被宿主打码时表单不会回传该字段（未修改），这里用已存值补齐；
          // 敏感字段同样回填，store.sanitize 会按三态重新落 SecretStorage。
          const conn = mergeSecretsFromStored(decodeConnection(msg.payload), this.editing);
          // '' 表示用户显式清空连接串；落库时归一为缺省（删除该字段）。
          if (conn.connectionUrl === '') conn.connectionUrl = undefined;
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
      // 敏感字段 + connectionUrl 内嵌凭据都不下发 webview；urlStripped 让表单在
      // 用户未修改 URL 时省略该字段，保存/测试时由宿主回填已存值。
      const { conn, urlStripped } = connectionPrefill(this.editing);
      this.post({ type: 'prefill', conn, urlStripped });
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
        const acquired = await SshTunnel.create({ ...effective, id: testId });
        if (acquired) { host = '127.0.0.1'; port = acquired.port; }
      }
      if (dbType === DatabaseType.ELASTICSEARCH) {
        // ES：临时客户端 + GET / 探活（认证/证书/路径前缀都按有效配置）；SSH 隧道由上面的临时建连提供。
        const client = new EsClient({
          protocol: esProtocolOf(effective),
          host,
          port,
          pathPrefix: effective.esPathPrefix,
          auth: esAuthOf(effective),
          tls: esTlsOf(effective),
          timeoutMs: effective.requestTimeout,
          readOnly: true,
        });
        try {
          const res = await client.ping();
          if (res.status >= 400) {
            const base = parseEsError(res.body)?.reason ?? `${l10n('conn.es.testFailed')} (HTTP ${res.status})`;
            const hint = esAuthMissingMessage(base, esAuthOf(effective).kind) ? `\n${l10n('conn.es.authRequired')}` : '';
            throw new Error(base + hint);
          }
        } finally {
          client.close();
        }
        const cost = Date.now() - start;
        return { ok: true, message: l10n('form.connected', { ms: cost }) };
      }
      if (dbType === DatabaseType.REDIS) {
        // Redis 三分派（D11）：standalone / cluster / sentinel。SSH 场景复用运行时隧道编排，
        // 以 testId 克隆 conn 合成隧道 id，finally 逐个回收，避免与正式会话的隧道冲突。
        const mode = effective.redisMode ?? 'standalone';
        const { common, auth } = redisTestCommon(effective);
        let client: RedisClient;
        let closeExtraTunnels: () => void = () => { /* 无 */ };
        try {
          if (mode === 'cluster' && effective.sshHost) {
            const setup = await setupClusterOverSsh({ ...effective, id: testId }, port, auth);
            closeExtraTunnels = () => { for (const id of setup.tunnelIds) SshTunnel.close(id); };
            client = new RedisClient({
              ...common,
              cluster: { nodes: [{ host: '127.0.0.1', port }], natMap: setup.natMap, slotsRefreshTimeout: effective.connectTimeout ?? 3000 },
            });
          } else if (mode === 'sentinel' && effective.sshHost) {
            if (!effective.sentinelName) throw new Error('Redis Sentinel master 名称未配置');
            const setup = await discoverSentinelMasterOverSsh({ ...effective, id: testId }, port, auth);
            closeExtraTunnels = () => SshTunnel.close(setup.tunnelId);
            client = new RedisClient({ ...common, host: '127.0.0.1', port: setup.masterLocalPort, db: effective.redisDb });
          } else {
            client = new RedisClient(redisTestClientOptions(effective, host, port));
          }
          try {
            await client.connect();
            await client.ping();
          } finally {
            await client.close();
          }
        } finally {
          closeExtraTunnels();
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
    case DatabaseType.ELASTICSEARCH: return 9200;
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
  // connectionUrl 内嵌凭据同样不下发 webview：未修改时表单省略该字段，回填已存值。
  if (out.connectionUrl === undefined && stored.connectionUrl !== undefined) {
    out.connectionUrl = stored.connectionUrl;
  }
  return out as unknown as SavedConnection;
}

/**
 * 编辑表单的 prefill 载荷：删除 SecretStorage 字段，并剥离 connectionUrl 内嵌凭据。
 *
 * connectionUrl 不是 SENSITIVE_FIELDS 的成员（它随 E2EE 密文同步是产品已确认的边界），
 * 但把含密码的完整 URL 下发 webview 会让密码进入 DOM/内存。这里只下发去密版本，
 * `urlStripped` 供表单在用户未修改时省略该字段、由宿主回填原值。
 */
export function connectionPrefill(conn: SavedConnection): { conn: SavedConnection; urlStripped: boolean } {
  const { out, urlStripped } = sanitizeConnectionForExport(conn);
  return { conn: out as unknown as SavedConnection, urlStripped };
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
    // 三态：undefined=未提交（保留已存值）；''=显式清空；其余按输入值。
    connectionUrl: payload.connectionUrl === undefined || payload.connectionUrl === null
      ? undefined
      : String(payload.connectionUrl),
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
    // Elasticsearch（P8 S2）：协议/路径前缀/认证方式；密码与 API Key 为敏感字段（'' 显式清除）。
    esProtocol: payload.esProtocol === 'https' ? 'https' : payload.esProtocol === 'http' ? 'http' : undefined,
    esPathPrefix: payload.esPathPrefix || undefined,
    esAuth: decodeEsAuth(payload.esAuth),
    esPassword: payload.esPassword,
    esApiKey: payload.esApiKey,
    color: payload.color || undefined,
  };
}

/** 认证对象白名单解码（缺省/非法 → undefined，按 none 处理）。 */
function decodeEsAuth(v: unknown): SavedConnection['esAuth'] {
  if (!v || typeof v !== 'object') return undefined;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'basic') return { kind: 'basic', username: String((v as { username?: unknown }).username ?? '') };
  if (kind === 'apiKey') return { kind: 'apiKey' };
  return undefined;
}
