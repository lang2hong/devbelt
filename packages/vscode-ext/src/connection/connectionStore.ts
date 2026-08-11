import type { ConnectionConfig } from '@db-client/core';
import { DatabaseType } from '@db-client/core';
import type { SavedQuery } from '@db-client/core';
import type { SecretStorage } from 'vscode';
import { QueryStore, type QueryFolder } from './queryStore';

/**
 * 已保存的连接（持久化到 VSCode 全局状态）。
 * 在 db-core 的 ConnectionConfig 基础上补充展示名与数据库类型。
 */
export interface SavedConnection extends ConnectionConfig {
  /** 唯一标识，用于状态存取 */
  id: string;
  /** 展示名 */
  name: string;
  /** 数据库类型 */
  dbType: DatabaseType;
  /** 所属分组 id；未分组为 undefined */
  groupId?: string;
  /** SSH 隧道主机（为空表示不使用 SSH） */
  sshHost?: string;
  /** SSH 端口（默认 22） */
  sshPort?: number;
  /** SSH 用户名 */
  sshUser?: string;
  /** SSH 密码认证 */
  sshPassword?: string;
  /** SSH 私钥路径 */
  sshPrivateKeyPath?: string;
  /** SSH 私钥密码 */
  sshPassphrase?: string;
  /** Connection environment controls additional execution safeguards. */
  environment?: 'development' | 'test' | 'staging' | 'production';
  /** Reject write statements before they are sent to the database. */
  readOnly?: boolean;
}

/**
 * 连接分组（支持层级：通过 parentId 嵌套）。
 */
export interface ConnectionGroup {
  /** 分组唯一 id */
  id: string;
  /** 分组名 */
  name: string;
  /** 父分组 id；顶层分组为 undefined */
  parentId?: string;
}

/**
 * 连接树根数据模型：分组树 + 连接集合。
 */
export interface ConnectionTreeData {
  groups: ConnectionGroup[];
  connections: SavedConnection[];
}

/**
 * 空数据模型工厂。
 */
export function emptyTreeData(): ConnectionTreeData {
  return { groups: [], connections: [] };
}

/** 保存查询文件夹（本地存储）。 */
export type { QueryFolder } from './queryStore';

/**
 * 连接存储：负责分组与连接的增删改查。
 * 使用 VSCode 全局状态（Memento）持久化，跨窗口共享。
 * 保存查询与文件夹委托给内部的 QueryStore。
 */
export class ConnectionStore {
  private static readonly KEY = 'dbclient.connectionsV2';
  private static readonly SENSITIVE_FIELDS = ['password', 'sshPassword', 'sshPassphrase'] as const;
  private readonly secretCache = new Map<string, string>();
  private readonly queryStore: QueryStore;

  constructor(
    private readonly memento: {
      get<T>(key: string): T | undefined;
      update(key: string, value: any): Thenable<void>;
    },
    private readonly secrets: SecretStorage,
  ) {
    this.queryStore = new QueryStore(memento);
  }

  /**
   * Moves legacy plaintext credentials out of Memento before the explorer is
   * initialized. Sync payloads only ever use the sanitized tree afterwards.
   */
  async init(): Promise<void> {
    const data = this.getTreeData();
    let changed = false;
    data.connections = await Promise.all(data.connections.map(async (connection) => {
      const { connection: sanitized, changed: connectionChanged } = await this.sanitize(connection);
      changed ||= connectionChanged;
      return sanitized;
    }));
    if (changed) await this.memento.update(ConnectionStore.KEY, data);
  }

  /** 读取完整树数据 */
  getTreeData(): ConnectionTreeData {
    return this.memento.get<ConnectionTreeData>(ConnectionStore.KEY) || emptyTreeData();
  }

  /** 读取全部分组 */
  getGroups(): ConnectionGroup[] {
    return this.getTreeData().groups;
  }

  /** 读取全部已保存连接 */
  list(): SavedConnection[] {
    return this.getTreeData().connections.map((connection) => this.materialize(connection));
  }

  /** 按 id 查找连接，未找到返回 undefined */
  get(id: string): SavedConnection | undefined {
    const connection = this.getTreeData().connections.find((c) => c.id === id);
    return connection ? this.materialize(connection) : undefined;
  }

  /** 新增或更新连接（按 id 覆盖） */
  async save(conn: SavedConnection): Promise<void> {
    const data = this.getTreeData();
    const { connection } = await this.sanitize(conn);
    const idx = data.connections.findIndex((c) => c.id === connection.id);
    if (idx >= 0) {
      data.connections[idx] = connection;
    } else {
      data.connections.push(connection);
    }
    await this.memento.update(ConnectionStore.KEY, data);
  }

  /** 删除连接 */
  async remove(id: string): Promise<void> {
    const data = this.getTreeData();
    data.connections = data.connections.filter((c) => c.id !== id);
    await this.memento.update(ConnectionStore.KEY, data);
    await Promise.all(ConnectionStore.SENSITIVE_FIELDS.map(async (field) => {
      this.secretCache.delete(this.secretKey(id, field));
      await this.secrets.delete(this.secretKey(id, field));
    }));
  }

  /** 移动连接到指定分组 */
  async moveToGroup(connId: string, groupId?: string): Promise<void> {
    const data = this.getTreeData();
    const conn = data.connections.find((c) => c.id === connId);
    if (!conn) return;
    conn.groupId = groupId;
    await this.memento.update(ConnectionStore.KEY, data);
  }

  /** 新建分组，返回其 id */
  async addGroup(name: string, parentId?: string): Promise<string> {
    const data = this.getTreeData();
    const group: ConnectionGroup = { id: `g-${Date.now()}`, name, parentId };
    data.groups.push(group);
    await this.memento.update(ConnectionStore.KEY, data);
    return group.id;
  }

  /** 以指定 id 创建分组（导入用，保留原 id 以维持连接归属） */
  async addGroupRaw(id: string, name: string, parentId?: string): Promise<void> {
    if (!id) return;
    const data = this.getTreeData();
    if (data.groups.some((g) => g.id === id)) return;
    data.groups.push({ id, name, parentId });
    await this.memento.update(ConnectionStore.KEY, data);
  }

  /** 重命名分组 */
  async renameGroup(id: string, name: string): Promise<void> {
    const data = this.getTreeData();
    const g = data.groups.find((x) => x.id === id);
    if (g) g.name = name;
    await this.memento.update(ConnectionStore.KEY, data);
  }

  /** 删除分组（递归删除子分组，组内连接移回未分组） */
  async removeGroup(id: string): Promise<void> {
    const data = this.getTreeData();
    const toDelete = new Set<string>();
    const collect = (gid: string) => {
      toDelete.add(gid);
      data.groups.filter((x) => x.parentId === gid).forEach((child) => collect(child.id));
    };
    collect(id);
    data.groups = data.groups.filter((g) => !toDelete.has(g.id));
    // 被删分组内的连接移回未分组
    data.connections.forEach((c) => {
      if (c.groupId && toDelete.has(c.groupId)) c.groupId = undefined;
    });
    await this.memento.update(ConnectionStore.KEY, data);
  }

  /** 整体覆写树数据（同步用） */
  async replaceAll(data: ConnectionTreeData): Promise<void> {
    const existing = new Map(this.getTreeData().connections.map((connection) => [connection.id, connection]));
    const connections = await Promise.all(data.connections.map(async (connection) => {
      const previous = existing.get(connection.id);
      if (previous && !this.hasSameTarget(previous, connection)) {
        await this.clearSecrets(connection.id);
      }
      // Remote sync is metadata-only; never import credentials even from a legacy payload.
      const remote = { ...connection };
      for (const field of ConnectionStore.SENSITIVE_FIELDS) delete remote[field];
      return (await this.sanitize(remote)).connection;
    }));
    await this.memento.update(ConnectionStore.KEY, { ...data, connections });
  }

  /** Returns a credential-free snapshot suitable for encrypted remote sync. */
  getSyncTreeData(): ConnectionTreeData {
    return JSON.parse(JSON.stringify(this.getTreeData())) as ConnectionTreeData;
  }

  private async sanitize(connection: SavedConnection): Promise<{ connection: SavedConnection; changed: boolean }> {
    const sanitized = { ...connection } as Record<string, unknown>;
    let changed = false;
    for (const field of ConnectionStore.SENSITIVE_FIELDS) {
      const key = this.secretKey(connection.id, field);
      const value = sanitized[field];
      if (typeof value === 'string' && value.length > 0) {
        await this.secrets.store(key, value);
        this.secretCache.set(key, value);
        delete sanitized[field];
        changed = true;
      } else {
        const stored = await this.secrets.get(key);
        if (stored !== undefined) this.secretCache.set(key, stored);
      }
    }
    return { connection: sanitized as unknown as SavedConnection, changed };
  }

  private materialize(connection: SavedConnection): SavedConnection {
    const resolved = { ...connection } as Record<string, unknown>;
    for (const field of ConnectionStore.SENSITIVE_FIELDS) {
      const value = this.secretCache.get(this.secretKey(connection.id, field));
      if (value !== undefined) resolved[field] = value;
    }
    if (!resolved.dbType) resolved.dbType = DatabaseType.MYSQL;
    return resolved as unknown as SavedConnection;
  }

  private secretKey(id: string, field: typeof ConnectionStore.SENSITIVE_FIELDS[number]): string {
    return `dbclient.connection.${id}.${field}`;
  }

  /** Credentials never follow a synchronized connection to a changed endpoint. */
  private hasSameTarget(a: SavedConnection, b: SavedConnection): boolean {
    const target = (connection: SavedConnection) => [
      connection.dbType,
      connection.host,
      connection.port,
      connection.user,
      connection.database,
      connection.schema,
      connection.dbPath,
      connection.socketPath,
      connection.useConnectionString,
      connection.connectionUrl,
      connection.sshHost,
      connection.sshPort,
      connection.sshUser,
      connection.sshPrivateKeyPath,
    ];
    return JSON.stringify(target(a)) === JSON.stringify(target(b));
  }

  private async clearSecrets(id: string): Promise<void> {
    await Promise.all(ConnectionStore.SENSITIVE_FIELDS.map(async (field) => {
      this.secretCache.delete(this.secretKey(id, field));
      await this.secrets.delete(this.secretKey(id, field));
    }));
  }

  // ─── 本地查询存储（Navicat Queries 分类） ───

  /** 读取指定连接+数据库下的保存查询 */
  getQueries(connId: string, database?: string): SavedQuery[] {
    return this.queryStore.getQueries(connId, database);
  }

  /** 读取指定连接+数据库+文件夹下的保存查询（根级：folderId 为 undefined） */
  getQueriesInFolder(connId: string, database: string | undefined, folderId?: string): SavedQuery[] {
    return this.queryStore.getQueriesInFolder(connId, database, folderId);
  }

  /** 新增保存查询，返回其 id */
  saveQuery(q: Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    return this.queryStore.saveQuery(q);
  }

  /** 更新保存查询 */
  updateQuery(id: string, patch: Partial<Pick<SavedQuery, 'name' | 'sql'>>): Promise<void> {
    return this.queryStore.updateQuery(id, patch);
  }

  /** 删除保存查询 */
  removeQuery(id: string): Promise<void> {
    return this.queryStore.removeQuery(id);
  }

  // ─── 保存查询文件夹 ───

  /** 读取全部保存查询文件夹 */
  getQueryFolders(): QueryFolder[] {
    return this.queryStore.getQueryFolders();
  }

  /** 新建保存查询文件夹，返回其 id */
  addQueryFolder(name: string): Promise<string> {
    return this.queryStore.addQueryFolder(name);
  }

  /** 重命名保存查询文件夹 */
  renameQueryFolder(id: string, name: string): Promise<void> {
    return this.queryStore.renameQueryFolder(id, name);
  }

  /** 删除保存查询文件夹，内部查询移回根级 */
  removeQueryFolder(id: string): Promise<void> {
    return this.queryStore.removeQueryFolder(id);
  }
}
