import type { ConnectionConfig } from '@db-client/core';
import { DatabaseType } from '@db-client/core';
import type { SavedQuery } from '@db-client/core';
import type { SecretStorage } from 'vscode';
import { QueryStore, type QueryFolder } from './queryStore';
import { mergeById } from '../utils/merge';
import { uniqueId } from '../utils/id';
import { EventEmitter, type Event, eventBus, ConnectionChangedEvent } from '../utils/event';

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
  /** 创建时间戳（ms） */
  createTime?: number;
  /** 最近更新时间戳（ms），合并同步按此判定先后 */
  updateTime?: number;
  /** 软删除墓碑：true 表示已删除，记录保留以跨端传播删除语义 */
  deleted?: boolean;
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
  /** 创建时间戳（ms） */
  createTime?: number;
  /** 最近更新时间戳（ms） */
  updateTime?: number;
  /** 软删除墓碑 */
  deleted?: boolean;
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
 * 删除为软删除（置 `deleted` 墓碑），记录保留以支持跨端同步传播删除语义。
 * 密码存于 SecretStorage，同步时随 E2EE payload 一并materialize/还原。
 */
export class ConnectionStore {
  private static readonly KEY = 'dbclient.connectionsV2';
  private static readonly SENSITIVE_FIELDS = ['password', 'sshPassword', 'sshPassphrase'] as const;
  private readonly secretCache = new Map<string, string>();
  private readonly queryStore: QueryStore;
  private readonly changedEmitter = new EventEmitter<void>();
  /** 数据变更事件（连接/分组/查询，含子 QueryStore 转发），供自动同步订阅。 */
  readonly onChanged: Event<void> = this.changedEmitter.event;

  constructor(
    private readonly memento: {
      get<T>(key: string): T | undefined;
      update(key: string, value: any): Thenable<void>;
    },
    private readonly secrets: SecretStorage,
  ) {
    this.queryStore = new QueryStore(memento);
    this.queryStore.onChanged(() => {
      this.changedEmitter.fire();
      void eventBus.publish(new ConnectionChangedEvent('connection', 'update'));
    });
  }

  /**
   * 初始化：迁移历史明文凭据到 SecretStorage，并为连接/分组补全
   * `createTime`/`updateTime`/`deleted` 默认值；同时迁移保存查询字段名。幂等。
   */
  async init(): Promise<void> {
    const data = this.getTreeData();
    let changed = false;

    // 分组字段补全
    data.groups.forEach((g: ConnectionGroup) => {
      if (g.createTime === undefined) { g.createTime = 0; changed = true; }
      if (g.updateTime === undefined) { g.updateTime = 0; changed = true; }
      if (g.deleted === undefined) { g.deleted = false; changed = true; }
    });

    // 连接：历史凭据迁移 + 字段补全
    let connChanged = false;
    data.connections = await Promise.all(data.connections.map(async (connection) => {
      const { connection: sanitized, changed: sanitizeChanged } = await this.sanitize(connection);
      connChanged ||= sanitizeChanged;
      if (sanitized.createTime === undefined) { sanitized.createTime = 0; connChanged = true; }
      if (sanitized.updateTime === undefined) { sanitized.updateTime = 0; connChanged = true; }
      if (sanitized.deleted === undefined) { sanitized.deleted = false; connChanged = true; }
      return sanitized;
    }));
    changed ||= connChanged;
    if (changed) await this.memento.update(ConnectionStore.KEY, data);

    await this.queryStore.migrate();
  }

  /**
   * 读取完整树数据（**含软删除墓碑**）。
   *
   * 墓碑是同步合并的依据（删除必须能传播到其他设备），所以持久层保留它们。
   * 面向 UI 的读取一律用 `getVisibleTreeData()`，否则已删除的连接/分组仍会显示。
   */
  getTreeData(): ConnectionTreeData {
    return this.memento.get<ConnectionTreeData>(ConnectionStore.KEY) || emptyTreeData();
  }

  /**
   * 读取树数据并剔除软删除墓碑，供树视图与各类选择器使用。
   *
   * 与 `list()`/`getGroups()` 过滤规则一致，但保留 `{groups, connections}` 结构，
   * 让调用方能按 `groupId`/`parentId` 做层级组装。
   */
  getVisibleTreeData(): ConnectionTreeData {
    const data = this.getTreeData();
    return {
      groups: data.groups.filter((g) => !g.deleted),
      connections: data.connections.filter((c) => !c.deleted),
    };
  }

  /** 读取全部分组（已过滤软删除墓碑） */
  getGroups(): ConnectionGroup[] {
    return this.getTreeData().groups.filter((g) => !g.deleted);
  }

  /** 读取全部已保存连接（已过滤软删除墓碑） */
  list(): SavedConnection[] {
    return this.getTreeData().connections.filter((c) => !c.deleted).map((connection) => this.materialize(connection));
  }

  /** 按 id 查找连接（跳过软删除），未找到返回 undefined */
  get(id: string): SavedConnection | undefined {
    const connection = this.getTreeData().connections.find((c) => c.id === id && !c.deleted);
    return connection ? this.materialize(connection) : undefined;
  }

  /** 新增或更新连接（按 id 覆盖） */
  async save(conn: SavedConnection): Promise<void> {
    const data = this.getTreeData();
    const { connection } = await this.sanitize(conn);
    const now = Date.now();
    const idx = data.connections.findIndex((c) => c.id === connection.id);
    const isNew = idx < 0;
    if (idx >= 0) {
      connection.createTime = connection.createTime ?? data.connections[idx].createTime ?? now;
      connection.updateTime = now;
      data.connections[idx] = connection;
    } else {
      connection.createTime = connection.createTime ?? now;
      connection.updateTime = now;
      if (connection.deleted === undefined) connection.deleted = false;
      data.connections.push(connection);
    }
    await this.memento.update(ConnectionStore.KEY, data);
    this.changedEmitter.fire();
    void eventBus.publish(new ConnectionChangedEvent('connection', isNew ? 'create' : 'update', connection.id));
  }

  /** 删除连接（软删除：置墓碑，记录保留；清理凭据以避免墓碑携带密码） */
  async remove(id: string): Promise<void> {
    const data = this.getTreeData();
    const conn = data.connections.find((c) => c.id === id);
    if (!conn) return;
    conn.deleted = true;
    conn.updateTime = Date.now();
    await this.memento.update(ConnectionStore.KEY, data);
    await this.clearSecrets(id);
    this.changedEmitter.fire();
    void eventBus.publish(new ConnectionChangedEvent('connection', 'delete', id));
  }

  /** 移动连接到指定分组 */
  async moveToGroup(connId: string, groupId?: string): Promise<void> {
    const data = this.getTreeData();
    const conn = data.connections.find((c) => c.id === connId);
    if (!conn) return;
    conn.groupId = groupId;
    conn.updateTime = Date.now();
    await this.memento.update(ConnectionStore.KEY, data);
    this.changedEmitter.fire();
    void eventBus.publish(new ConnectionChangedEvent('connection', 'move', connId));
  }

  /** 新建分组，返回其 id */
  async addGroup(name: string, parentId?: string): Promise<string> {
    const data = this.getTreeData();
    const now = Date.now();
    const group: ConnectionGroup = { id: uniqueId('g'), name, parentId, createTime: now, updateTime: now, deleted: false };
    data.groups.push(group);
    await this.memento.update(ConnectionStore.KEY, data);
    this.changedEmitter.fire();
    void eventBus.publish(new ConnectionChangedEvent('group', 'create', group.id));
    return group.id;
  }

  /** 以指定 id 创建分组（导入用，保留原 id 以维持连接归属） */
  async addGroupRaw(id: string, name: string, parentId?: string): Promise<void> {
    if (!id) return;
    const data = this.getTreeData();
    if (data.groups.some((g) => g.id === id)) return;
    const now = Date.now();
    data.groups.push({ id, name, parentId, createTime: now, updateTime: now, deleted: false });
    await this.memento.update(ConnectionStore.KEY, data);
    this.changedEmitter.fire();
    void eventBus.publish(new ConnectionChangedEvent('group', 'create', id));
  }

  /** 重命名分组 */
  async renameGroup(id: string, name: string): Promise<void> {
    const data = this.getTreeData();
    const g = data.groups.find((x) => x.id === id);
    if (g) {
      g.name = name;
      g.updateTime = Date.now();
      await this.memento.update(ConnectionStore.KEY, data);
      this.changedEmitter.fire();
      void eventBus.publish(new ConnectionChangedEvent('group', 'update', id));
    }
  }

  /** 删除分组（递归软删除子分组，组内连接一并软删除并清凭据） */
  async removeGroup(id: string): Promise<void> {
    const data = this.getTreeData();
    const toDelete = new Set<string>();
    const collect = (gid: string) => {
      toDelete.add(gid);
      data.groups.filter((x) => x.parentId === gid).forEach((child) => collect(child.id));
    };
    collect(id);
    const now = Date.now();
    data.groups.forEach((g) => {
      if (toDelete.has(g.id)) { g.deleted = true; g.updateTime = now; }
    });
    const deletedConnIds: string[] = [];
    data.connections.forEach((c) => {
      if (c.groupId && toDelete.has(c.groupId)) {
        c.deleted = true;
        c.groupId = undefined;
        c.updateTime = now;
        deletedConnIds.push(c.id);
      }
    });
    await this.memento.update(ConnectionStore.KEY, data);
    for (const connId of deletedConnIds) {
      await this.clearSecrets(connId);
      void eventBus.publish(new ConnectionChangedEvent('connection', 'delete', connId));
    }
    this.changedEmitter.fire();
    void eventBus.publish(new ConnectionChangedEvent('group', 'delete', id));
  }

  /**
   * 合并远端树数据到本地（同步 pull 用）。
   *  - 分组与连接按 id 并集合并：删除优先，否则最新 `updateTime` 胜。
   *  - 连接密码（敏感字段）随胜出记录处理：有值则写回 SecretStorage，无值则清理本地残留凭据。
   *  - memento 始终存储剥离凭据的版本。
   */
  async replaceAllMerge(remote: ConnectionTreeData): Promise<void> {
    const local = this.getTreeData();
    const localConns = await Promise.all(local.connections.map((c) => this.materializeAsync(c)));
    const mergedGroups = mergeById(local.groups, remote.groups);
    const mergedConns = mergeById(localConns, remote.connections);

    const oldConnMap = new Map(localConns.map((c) => [c.id, c]));
    const oldGroupMap = new Map(local.groups.map((g) => [g.id, g]));
    const newConnMap = new Map(mergedConns.map((c) => [c.id, c]));
    const newGroupMap = new Map(mergedGroups.map((g) => [g.id, g]));

    const sanitized = await Promise.all(mergedConns.map(async (c) => this.reconcileSecrets(c)));
    const merged = { groups: mergedGroups, connections: sanitized };
    await this.memento.update(ConnectionStore.KEY, merged);
    this.changedEmitter.fire();

    for (const [id, conn] of newConnMap) {
      const old = oldConnMap.get(id);
      if (!old) {
        void eventBus.publish(new ConnectionChangedEvent('connection', 'create', id));
      } else if (conn.deleted !== old.deleted || conn.updateTime !== old.updateTime) {
        void eventBus.publish(new ConnectionChangedEvent('connection', conn.deleted ? 'delete' : 'update', id));
      }
    }
    for (const [id, g] of newGroupMap) {
      const old = oldGroupMap.get(id);
      if (!old) {
        void eventBus.publish(new ConnectionChangedEvent('group', 'create', id));
      } else if (g.deleted !== old.deleted || g.updateTime !== old.updateTime) {
        void eventBus.publish(new ConnectionChangedEvent('group', g.deleted ? 'delete' : 'update', id));
      }
    }
  }

  /**
   * 同步：全量替换（use remote 策略）——本地分组/连接整个替换为远端，不做 id 并集，
   * 本地独有项随之丢弃。凭据沿用 reconcileSecrets 处理（远端有值写回、无值清理）。
   * 不逐条派发 ConnectionChangedEvent：use remote 后由调用方全量 refresh 树。
   */
  async replaceAll(remote: ConnectionTreeData): Promise<void> {
    const sanitized = await Promise.all(remote.connections.map(async (c) => this.reconcileSecrets(c)));
    await this.memento.update(ConnectionStore.KEY, { groups: remote.groups, connections: sanitized });
    this.changedEmitter.fire();
  }

  /**
   * 读取连接明文元数据（上传服务端计量/分析用，不含任何敏感字段）。
   * 返回结构对齐服务端 connection_meta 表：type/name/groupName/enabled/deleted/时间戳。
   */
  getConnectionMeta(): Array<{
    connUuid: string; type: string; name: string; groupName?: string;
    enabled: boolean; deleted: boolean; createdAt?: number; updatedAt?: number;
  }> {
    const data = this.getTreeData();
    const groupNameById = new Map<string, string>();
    for (const g of data.groups) groupNameById.set(g.id, g.name);
    return data.connections.map((c) => ({
      connUuid: c.id,
      type: c.dbType,
      name: c.name,
      groupName: c.groupId ? groupNameById.get(c.groupId) : undefined,
      enabled: true,
      deleted: !!c.deleted,
      createdAt: c.createTime,
      updatedAt: c.updateTime,
    }));
  }

  /**
   * 读取同步用全量数据：连接 materialize 含密码（含墓碑），分组原样。
   * 该结果经 SyncManager 加密后上传；服务端只见密文。
   */
  async getSyncData(): Promise<ConnectionTreeData> {
    const tree = this.getTreeData();
    const connections = await Promise.all(tree.connections.map((c) => this.materializeAsync(c)));
    return { groups: tree.groups, connections };
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
      } else if (sanitized[field] === '') {
        this.secretCache.delete(key);
        await this.secrets.delete(key);
        delete sanitized[field];
        changed = true;
      } else {
        const stored = await this.secrets.get(key);
        if (stored !== undefined) this.secretCache.set(key, stored);
      }
    }
    return { connection: sanitized as unknown as SavedConnection, changed };
  }

  /**
   * 合并后凭据对账：胜出记录的敏感字段为权威值——有值写回 SecretStorage，
   * 无值则清理本地残留凭据（远端权威地表示该连接无此密码）。
   * 返回剥离敏感字段的版本供 memento 存储。
   */
  private async reconcileSecrets(connection: SavedConnection): Promise<SavedConnection> {
    const out = { ...connection } as Record<string, unknown>;
    for (const field of ConnectionStore.SENSITIVE_FIELDS) {
      const key = this.secretKey(connection.id, field);
      const value = out[field];
      if (typeof value === 'string' && value.length > 0) {
        await this.secrets.store(key, value);
        this.secretCache.set(key, value);
      } else {
        this.secretCache.delete(key);
        await this.secrets.delete(key);
      }
      delete out[field];
    }
    if (out.createTime === undefined) out.createTime = 0;
    if (out.updateTime === undefined) out.updateTime = 0;
    if (out.deleted === undefined) out.deleted = false;
    return out as unknown as SavedConnection;
  }

  private materialize(connection: SavedConnection): SavedConnection {
    const resolved = { ...connection } as Record<string, unknown>;
    for (const field of ConnectionStore.SENSITIVE_FIELDS) {
      const value = this.secretCache.get(this.secretKey(connection.id, field));
      if (value !== undefined) resolved[field] = value;
    }
    return resolved as unknown as SavedConnection;
  }

  /** materialize 但从 SecretStorage 异步读取未缓存凭据（同步 push 用） */
  private async materializeAsync(connection: SavedConnection): Promise<SavedConnection> {
    const resolved = { ...connection } as Record<string, unknown>;
    for (const field of ConnectionStore.SENSITIVE_FIELDS) {
      const key = this.secretKey(connection.id, field);
      let value = this.secretCache.get(key);
      if (value === undefined) {
        const stored = await this.secrets.get(key);
        if (stored !== undefined) {
          this.secretCache.set(key, stored);
          value = stored;
        }
      }
      if (value !== undefined) resolved[field] = value;
    }
    return resolved as unknown as SavedConnection;
  }

  private secretKey(id: string, field: typeof ConnectionStore.SENSITIVE_FIELDS[number]): string {
    return `dbclient.connection.${id}.${field}`;
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
  saveQuery(q: Omit<SavedQuery, 'id' | 'createTime' | 'updateTime'>): Promise<string> {
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

  /** 同步：读取保存查询原始数据（含墓碑） */
  getQueriesForSync(): { queries: SavedQuery[]; folders: QueryFolder[] } {
    return this.queryStore.getSyncData();
  }

  /** 同步：合并远端保存查询数据 */
  replaceQueriesForSync(remote: { queries: SavedQuery[]; folders: QueryFolder[] }): Promise<void> {
    return this.queryStore.replaceAllMerge(remote);
  }

  /** 同步：全量替换远端保存查询数据（use remote 策略） */
  replaceQueriesForSyncAll(remote: { queries: SavedQuery[]; folders: QueryFolder[] }): Promise<void> {
    return this.queryStore.replaceAll(remote);
  }
}
