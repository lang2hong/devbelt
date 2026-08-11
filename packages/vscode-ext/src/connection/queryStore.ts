import type { SavedQuery } from '@db-client/core';

/** 保存查询文件夹（本地存储）。 */
export interface QueryFolder {
  id: string;
  name: string;
}

/** 轻量 memento 接口，避免循环依赖具体存储实现。 */
interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}

/**
 * 查询存储：负责保存查询与查询文件夹的增删改查。
 * 与连接存储共用同一个 memento，但业务上完全独立。
 */
export class QueryStore {
  private static readonly QKEY = 'dbclient.queries';
  private static readonly FKEY = 'dbclient.queryFolders';

  constructor(private readonly memento: MementoLike) {}

  /** 读取指定连接+数据库下的保存查询 */
  getQueries(connId: string, database?: string): SavedQuery[] {
    const all = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    return all.filter((q) => q.connId === connId && (!database || q.database === database));
  }

  /** 读取指定连接+数据库+文件夹下的保存查询（根级：folderId 为 undefined） */
  getQueriesInFolder(connId: string, database: string | undefined, folderId?: string): SavedQuery[] {
    return this.getQueries(connId, database).filter((q) => (q.folderId || undefined) === folderId);
  }

  /** 新增保存查询，返回其 id */
  async saveQuery(q: Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const all = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    const now = Date.now();
    const query: SavedQuery = { ...q, id: `q-${now}`, createdAt: now, updatedAt: now };
    all.push(query);
    await this.memento.update(QueryStore.QKEY, all);
    return query.id;
  }

  /** 更新保存查询 */
  async updateQuery(id: string, patch: Partial<Pick<SavedQuery, 'name' | 'sql'>>): Promise<void> {
    const all = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    const idx = all.findIndex((q) => q.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], ...patch, updatedAt: Date.now() };
    await this.memento.update(QueryStore.QKEY, all);
  }

  /** 删除保存查询 */
  async removeQuery(id: string): Promise<void> {
    const all = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    await this.memento.update(
      QueryStore.QKEY,
      all.filter((q) => q.id !== id),
    );
  }

  /** 读取全部保存查询文件夹 */
  getQueryFolders(): QueryFolder[] {
    return this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
  }

  /** 新建保存查询文件夹，返回其 id */
  async addQueryFolder(name: string): Promise<string> {
    const all = this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
    const folder: QueryFolder = { id: `qf-${Date.now()}`, name };
    all.push(folder);
    await this.memento.update(QueryStore.FKEY, all);
    return folder.id;
  }

  /** 重命名保存查询文件夹 */
  async renameQueryFolder(id: string, name: string): Promise<void> {
    const all = this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
    const folder = all.find((f) => f.id === id);
    if (folder) {
      folder.name = name;
      await this.memento.update(QueryStore.FKEY, all);
    }
  }

  /** 删除保存查询文件夹，内部查询移回根级 */
  async removeQueryFolder(id: string): Promise<void> {
    const all = this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
    await this.memento.update(QueryStore.FKEY, all.filter((f) => f.id !== id));
    const queries = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    await this.memento.update(
      QueryStore.QKEY,
      queries.map((q) => (q.folderId === id ? { ...q, folderId: undefined } : q)),
    );
  }
}