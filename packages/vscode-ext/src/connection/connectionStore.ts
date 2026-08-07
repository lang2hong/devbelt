import type { ConnectionConfig, DatabaseType } from '@db-client/core';
import type { SavedQuery } from '@db-client/core';

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

/**
 * 连接存储：负责分组与连接的增删改查。
 * 使用 VSCode 全局状态（Memento）持久化，跨窗口共享。
 */
export class ConnectionStore {
  private static readonly KEY = 'dbclient.connectionsV2';

  constructor(
    private readonly memento: {
      get<T>(key: string): T | undefined;
      update(key: string, value: any): Thenable<void>;
    },
  ) {}

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
    return this.getTreeData().connections;
  }

  /** 按 id 查找连接，未找到返回 undefined */
  get(id: string): SavedConnection | undefined {
    return this.list().find((c) => c.id === id);
  }

  /** 新增或更新连接（按 id 覆盖） */
  async save(conn: SavedConnection): Promise<void> {
    const data = this.getTreeData();
    const idx = data.connections.findIndex((c) => c.id === conn.id);
    if (idx >= 0) {
      data.connections[idx] = conn;
    } else {
      data.connections.push(conn);
    }
    await this.memento.update(ConnectionStore.KEY, data);
  }

  /** 删除连接 */
  async remove(id: string): Promise<void> {
    const data = this.getTreeData();
    data.connections = data.connections.filter((c) => c.id !== id);
    await this.memento.update(ConnectionStore.KEY, data);
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
    await this.memento.update(ConnectionStore.KEY, data);
  }

  // ─── 本地查询存储（Navicat Queries 分类） ───

  private static readonly QKEY = 'dbclient.queries';

  /** 读取指定连接+数据库下的保存查询 */
  getQueries(connId: string, database?: string): SavedQuery[] {
    const all = this.memento.get<SavedQuery[]>(ConnectionStore.QKEY) || [];
    return all.filter((q) => q.connId === connId && (!database || q.database === database));
  }

  /** 新增保存查询，返回其 id */
  async saveQuery(q: Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const all = this.memento.get<SavedQuery[]>(ConnectionStore.QKEY) || [];
    const now = Date.now();
    const query: SavedQuery = { ...q, id: `q-${now}`, createdAt: now, updatedAt: now };
    all.push(query);
    await this.memento.update(ConnectionStore.QKEY, all);
    return query.id;
  }

  /** 更新保存查询 */
  async updateQuery(id: string, patch: Partial<Pick<SavedQuery, 'name' | 'sql'>>): Promise<void> {
    const all = this.memento.get<SavedQuery[]>(ConnectionStore.QKEY) || [];
    const idx = all.findIndex((q) => q.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() };
    await this.memento.update(ConnectionStore.QKEY, all);
  }

  /** 删除保存查询 */
  async removeQuery(id: string): Promise<void> {
    const all = this.memento.get<SavedQuery[]>(ConnectionStore.QKEY) || [];
    await this.memento.update(
      ConnectionStore.QKEY,
      all.filter((q) => q.id !== id),
    );
  }
}