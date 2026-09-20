import type { ThenableLike } from '../hostTypes.js';
import type { SavedQuery } from '@devkit/db-core';
import { mergeById } from '../utils/merge.js';
import { uniqueId } from '../utils/id.js';
import { EventEmitter, type Event } from '../utils/event.js';

/** 变更来源：远端同步应用为 sync（不触发用户侧回环），本地编辑为 user。 */
export type ChangeSource = 'user' | 'sync';

/** 保存查询文件夹（本地存储）。 */
export interface QueryFolder {
  id: string;
  name: string;
  /** 归属连接 id（v2 新增，必填）；文件夹跟随连接、扁平无层级。 */
  connId: string;
  /** 创建时间戳（ms） */
  createTime?: number;
  /** 最近更新时间戳（ms），合并同步按此判定先后 */
  updateTime?: number;
  /** 软删除墓碑 */
  deleted?: boolean;
}

/** 轻量 memento 接口，避免循环依赖具体存储实现。 */
interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): ThenableLike<void>;
}

/**
 * 查询存储：负责保存查询与查询文件夹的增删改查。
 * 与连接存储共用同一个 memento，但业务上完全独立。
 * 删除为软删除（置 `deleted` 墓碑），记录保留以支持跨端同步传播删除语义。
 * v2：QueryFolder 增加 `connId` 归属，`getQueryFolders` 按连接过滤。
 */
export class QueryStore {
  private static readonly QKEY = 'devbelt.queries';
  private static readonly FKEY = 'devbelt.queryFolders';

  private readonly changedEmitter = new EventEmitter<ChangeSource>();
  /** 数据变更事件（新增/更新/删除/合并），供自动同步订阅；source 区分本地/同步。 */
  readonly onChanged: Event<ChangeSource> = this.changedEmitter.event;

  constructor(private readonly memento: MementoLike) {}

  /**
   * 一次性迁移：把旧字段名 `createdAt/updatedAt` 重命名为 `createTime/updateTime`，
   * 并为查询与文件夹补默认 `deleted=false` / 时间戳。幂等。
   * v2：旧 QueryFolder 无 `connId` 的按「不可同步」tombstone 处理（D4/N5）。
   */
  async migrate(): Promise<void> {
    const queries = this.memento.get<any[]>(QueryStore.QKEY) || [];
    let qChanged = false;
    if (queries.length) {
      const migrated = queries.map((q) => {
        const out: any = { ...q };
        if ('createdAt' in out && !('createTime' in out)) { out.createTime = out.createdAt; qChanged = true; }
        if ('updatedAt' in out && !('updateTime' in out)) { out.updateTime = out.updatedAt; qChanged = true; }
        if ('createdAt' in out) { delete out.createdAt; qChanged = true; }
        if ('updatedAt' in out) { delete out.updatedAt; qChanged = true; }
        if (out.createTime === undefined) { out.createTime = 0; qChanged = true; }
        if (out.updateTime === undefined) { out.updateTime = 0; qChanged = true; }
        if (out.deleted === undefined) { out.deleted = false; qChanged = true; }
        return out;
      });
      if (qChanged) await this.memento.update(QueryStore.QKEY, migrated);
    }

    const folders = this.memento.get<any[]>(QueryStore.FKEY) || [];
    let fChanged = false;
    if (folders.length) {
      const migrated = folders.map((f) => {
        const out: any = { ...f };
        if (out.createTime === undefined) { out.createTime = 0; fChanged = true; }
        if (out.updateTime === undefined) { out.updateTime = 0; fChanged = true; }
        if (out.deleted === undefined) { out.deleted = false; fChanged = true; }
        // v2：无 connId 的旧文件夹标记为不可同步的 tombstone（不保守复制）。
        if (!out.connId) { out.deleted = true; fChanged = true; }
        return out;
      });
      if (fChanged) await this.memento.update(QueryStore.FKEY, migrated);
    }
  }

  /** 读取指定连接+数据库下的保存查询（已过滤软删除墓碑） */
  getQueries(connId: string, database?: string): SavedQuery[] {
    const all = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    return all.filter((q) => !q.deleted && q.connId === connId && (!database || q.database === database));
  }

  /** 读取指定连接+数据库+文件夹下的保存查询（根级：folderId 为 undefined） */
  getQueriesInFolder(connId: string, database: string | undefined, folderId?: string): SavedQuery[] {
    return this.getQueries(connId, database).filter((q) => (q.folderId || undefined) === folderId);
  }

  /** 按 id 读取查询（含墓碑），供同步 apply 冲突判定。 */
  getQueryById(id: string): SavedQuery | undefined {
    return (this.memento.get<SavedQuery[]>(QueryStore.QKEY) || []).find((q) => q.id === id);
  }

  /** 按 id 读取文件夹（含墓碑），供同步 apply 冲突判定。 */
  getFolderById(id: string): QueryFolder | undefined {
    return (this.memento.get<QueryFolder[]>(QueryStore.FKEY) || []).find((f) => f.id === id);
  }

  /** 新增保存查询，返回其 id */
  async saveQuery(q: Omit<SavedQuery, 'id' | 'createTime' | 'updateTime'>, source: ChangeSource = 'user'): Promise<string> {
    const all = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    const now = Date.now();
    const query: SavedQuery = { ...q, id: uniqueId('q'), createTime: now, updateTime: now, deleted: false };
    all.push(query);
    await this.memento.update(QueryStore.QKEY, all);
    this.changedEmitter.fire(source);
    return query.id;
  }

  /** 同步/导入写入：按 id 覆盖整条查询（含时间戳与墓碑字段）。 */
  async upsertQuery(query: SavedQuery, source: ChangeSource = 'sync'): Promise<void> {
    const all = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    const idx = all.findIndex((q) => q.id === query.id);
    // updateTime 为本地同步 revision，不随 payload 同步；写入时由 store 打点（见 upsertGroup）。
    const stored: SavedQuery = { ...query, updateTime: Date.now() };
    if (idx >= 0) all[idx] = stored;
    else all.push(stored);
    await this.memento.update(QueryStore.QKEY, all);
    this.changedEmitter.fire(source);
  }

  /** 更新保存查询 */
  async updateQuery(id: string, patch: Partial<Pick<SavedQuery, 'name' | 'sql'>>, source: ChangeSource = 'user'): Promise<void> {
    const all = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    const idx = all.findIndex((q) => q.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], ...patch, updateTime: Date.now() };
    await this.memento.update(QueryStore.QKEY, all);
    this.changedEmitter.fire(source);
  }

  /** 删除保存查询（软删除：置墓碑，记录保留以跨端传播） */
  async removeQuery(id: string, source: ChangeSource = 'user'): Promise<void> {
    const all = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    const idx = all.findIndex((q) => q.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], deleted: true, updateTime: Date.now() };
    await this.memento.update(QueryStore.QKEY, all);
    this.changedEmitter.fire(source);
  }

  /** 读取全部保存查询文件夹（已过滤软删除墓碑；可指定连接） */
  getQueryFolders(connId?: string): QueryFolder[] {
    return (this.memento.get<QueryFolder[]>(QueryStore.FKEY) || []).filter((f) => !f.deleted && (!connId || f.connId === connId));
  }

  /** 新建保存查询文件夹，返回其 id（v2：必须带归属连接） */
  async addQueryFolder(name: string, connId: string, source: ChangeSource = 'user'): Promise<string> {
    const all = this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
    const now = Date.now();
    const folder: QueryFolder = { id: uniqueId('qf'), name, connId, createTime: now, updateTime: now, deleted: false };
    all.push(folder);
    await this.memento.update(QueryStore.FKEY, all);
    this.changedEmitter.fire(source);
    return folder.id;
  }

  /** 同步/导入写入：按 id 覆盖整条文件夹。 */
  async upsertFolder(folder: QueryFolder, source: ChangeSource = 'sync'): Promise<void> {
    const all = this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
    const idx = all.findIndex((f) => f.id === folder.id);
    // updateTime 为本地同步 revision，不随 payload 同步；写入时由 store 打点（见 upsertGroup）。
    const stored: QueryFolder = { ...folder, updateTime: Date.now() };
    if (idx >= 0) all[idx] = stored;
    else all.push(stored);
    await this.memento.update(QueryStore.FKEY, all);
    this.changedEmitter.fire(source);
  }

  /** 重命名保存查询文件夹 */
  async renameQueryFolder(id: string, name: string, source: ChangeSource = 'user'): Promise<void> {
    const all = this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
    const folder = all.find((f) => f.id === id);
    if (folder) {
      folder.name = name;
      folder.updateTime = Date.now();
      await this.memento.update(QueryStore.FKEY, all);
      this.changedEmitter.fire(source);
    }
  }

  /** 删除保存查询文件夹（软删除），内部查询移回根级 */
  async removeQueryFolder(id: string, source: ChangeSource = 'user'): Promise<void> {
    const all = this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
    const folder = all.find((f) => f.id === id);
    if (folder) {
      folder.deleted = true;
      folder.updateTime = Date.now();
      await this.memento.update(QueryStore.FKEY, all);
    }
    // 内部查询移回根级（保留原 UX）
    const queries = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    let changed = false;
    const updated = queries.map((q) => {
      if (q.folderId === id) { changed = true; return { ...q, folderId: undefined, updateTime: Date.now() }; }
      return q;
    });
    if (changed) await this.memento.update(QueryStore.QKEY, updated);
    this.changedEmitter.fire(source);
  }

  // ─── 同步 ───

  /** 连接删除级联：同事务 tombstone 该连接下全部查询与查询文件夹（§三）。 */
  async cascadeDeleteByConnection(connId: string, source: ChangeSource = 'sync'): Promise<void> {
    const now = Date.now();
    const folders = this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
    let fChanged = false;
    const foldersUpdated = folders.map((f) => {
      if (f.connId === connId && !f.deleted) { fChanged = true; return { ...f, deleted: true, updateTime: now }; }
      return f;
    });
    const queries = this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
    let qChanged = false;
    const queriesUpdated = queries.map((q) => {
      if (q.connId === connId && !q.deleted) { qChanged = true; return { ...q, deleted: true, updateTime: now }; }
      return q;
    });
    if (fChanged) await this.memento.update(QueryStore.FKEY, foldersUpdated);
    if (qChanged) await this.memento.update(QueryStore.QKEY, queriesUpdated);
    if (fChanged || qChanged) this.changedEmitter.fire(source);
  }

  /** 读取同步用原始查询（含墓碑，未过滤） */
  listQueriesForSync(): SavedQuery[] {
    return this.memento.get<SavedQuery[]>(QueryStore.QKEY) || [];
  }

  /** 读取同步用原始文件夹（含墓碑，未过滤） */
  listFoldersForSync(): QueryFolder[] {
    return this.memento.get<QueryFolder[]>(QueryStore.FKEY) || [];
  }

  /** 读取同步用原始数据（含墓碑，未过滤） */
  getSyncData(): { queries: SavedQuery[]; folders: QueryFolder[] } {
    return {
      queries: this.listQueriesForSync(),
      folders: this.listFoldersForSync(),
    };
  }

  /** 合并远端数据到本地（并集 by id，删除优先，最新 updateTime 胜） */
  async replaceAllMerge(remote: { queries: SavedQuery[]; folders: QueryFolder[] }): Promise<void> {
    const local = this.getSyncData();
    const mergedQueries = mergeById(local.queries, remote.queries);
    const mergedFolders = mergeById(local.folders, remote.folders);
    await this.memento.update(QueryStore.QKEY, mergedQueries);
    await this.memento.update(QueryStore.FKEY, mergedFolders);
    this.changedEmitter.fire('sync');
  }

  /** 全量替换（use remote 策略）：本地查询/文件夹整个替换为远端，不做并集 */
  async replaceAll(remote: { queries: SavedQuery[]; folders: QueryFolder[] }): Promise<void> {
    await this.memento.update(QueryStore.QKEY, remote.queries);
    await this.memento.update(QueryStore.FKEY, remote.folders);
    this.changedEmitter.fire('sync');
  }
}