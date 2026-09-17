import type { SavedQuery } from '@devkit/db-core';
import type { ConnectionStore, SavedConnection, ConnectionGroup } from '../../connection/connectionStore';
import type { QueryFolder, ChangeSource } from '../../connection/queryStore';
import { SYNC_ENTITY_TYPES, type SyncEntityRef, type SyncEntityType } from './syncEntity';
import { assertU64Decimal } from './types';
import type { MementoLike } from './stateStore';

/**
 * 四类实体的统一适配层（A1）。
 *
 * 将 ConnectionStore（连接+分组）与 QueryStore（查询+文件夹）统一为以
 * `SyncEntityRef { type, localId }` 寻址的读写面，供 codec/apply/mutator 全链路消费。
 * 每类实体的本地唯一 id：connection → SavedConnection.id；group → ConnectionGroup.id；
 * queryFolder → QueryFolder.id；query → SavedQuery.id。
 *
 * 删除语义（§三）由底层 store 承担级联，适配层只做类型分派：
 *  - 连接 tombstone → ConnectionStore.remove（级联其查询与文件夹）
 *  - 分组 tombstone → ConnectionStore.removeGroup（成员连接移未分组，不删连接）
 *  - 文件夹 tombstone → QueryStore.removeQueryFolder（查询移根级）
 *  - 查询 tombstone → QueryStore.removeQuery
 */

/** 归一后的本地实体摘要（供对账 / 冲突判定）：统一了 updateTime 与 deleted。 */
export interface EntitySyncRecord {
  ref: SyncEntityRef;
  deleted: boolean;
  updateTime: number;
}

export type EntityValue = SavedConnection | ConnectionGroup | SavedQuery | QueryFolder;

/** 供 mutator/apply 读取实体当前的归一化摘要。 */
export function entitySummary(ref: SyncEntityRef, entity: EntityValue): EntitySyncRecord {
  const e = entity as { deleted?: boolean; updateTime?: number };
  return { ref, deleted: !!e.deleted, updateTime: e.updateTime ?? 0 };
}

export class EntityStore {
  constructor(private readonly store: ConnectionStore) {}

  /** 各类型全量实体（含墓碑）作为 {ref, deleted, updateTime} 摘要。 */
  listForSync(): EntitySyncRecord[] {
    const out: EntitySyncRecord[] = [];
    for (const c of this.store.listForSync()) {
      out.push(entitySummary({ type: 'connection', localId: c.id }, c));
    }
    for (const g of this.store.listGroupsForSync()) {
      out.push(entitySummary({ type: 'group', localId: g.id }, g));
    }
    for (const f of this.store.listFoldersForSync()) {
      out.push(entitySummary({ type: 'queryFolder', localId: f.id }, f));
    }
    for (const q of this.store.listQueriesForSync()) {
      out.push(entitySummary({ type: 'query', localId: q.id }, q));
    }
    return out;
  }

  /** 按 typed ref 读取本地实体（含墓碑），不存在返回 undefined。 */
  get(ref: SyncEntityRef): EntityValue | undefined {
    switch (ref.type) {
      case 'connection': return this.store.get(ref.localId) ?? this.getConnectionIncludingDeleted(ref.localId);
      case 'group': return this.store.getGroupById(ref.localId);
      case 'queryFolder': return this.store.getFolderById(ref.localId);
      case 'query': return this.store.getQueryById(ref.localId);
    }
  }

  /** 按 typed ref 写入（含墓碑字段；source 透传）。 */
  async save(ref: SyncEntityRef, entity: EntityValue, source: ChangeSource): Promise<void> {
    switch (ref.type) {
      case 'connection': return this.store.save(entity as SavedConnection, source);
      case 'group': return this.store.upsertGroup(entity as ConnectionGroup, source);
      case 'queryFolder': return this.store.upsertFolder(entity as QueryFolder, source);
      case 'query': return this.store.upsertQuery(entity as SavedQuery, source);
    }
  }

  /** 按 typed ref tombstone（source 透传，级联语义见类注释）。 */
  async remove(ref: SyncEntityRef, source: ChangeSource): Promise<void> {
    switch (ref.type) {
      case 'connection': return this.store.remove(ref.localId, source);
      case 'group': return this.store.removeGroup(ref.localId, source);
      case 'queryFolder': return this.store.removeQueryFolder(ref.localId, source);
      case 'query': return this.store.removeQuery(ref.localId, source);
    }
  }

  private getConnectionIncludingDeleted(localId: string): SavedConnection | undefined {
    return this.store.listForSync().find((c) => c.id === localId);
  }
}

export function applyOrder(type: SyncEntityType): number {
  // 依赖方向：group(被 connection 引用) → connection(被 folder/query 引用) →
  // queryFolder(被 query 引用) → query。父实体必须先于子实体 mint/apply，
  // 批内引用才能立即翻译（否则入 unresolved）。
  switch (type) {
    case 'group': return 0;
    case 'connection': return 1;
    case 'queryFolder': return 2;
    case 'query': return 3;
  }
}

export function typeList(): readonly SyncEntityType[] {
  return SYNC_ENTITY_TYPES;
}

/**
 * unresolved 引用持久化（N4）。
 *
 * 应用远端实体时，若其引用（parentId/groupId/connId/folderId）指向的 recordId 尚未映射
 * 到本地实体（未到达/pending/tombstone），保留该引用而非静默归根/未分组。键按
 * userId+keyEpoch 隔离，持久化 recordId → 依赖方引用列表，供后续轮次 reconcile 收敛。
 */

export interface UnresolvedRef {
  /** 被依赖目标的 sync recordId（父实体）。 */
  targetRecordId: string;
  /** 依赖方本地实体。 */
  type: SyncEntityType;
  localId: string;
  /** 依赖方上的字段名：groupId / parentId / connId / folderId。 */
  field: 'groupId' | 'parentId' | 'connId' | 'folderId';
}

interface UnresolvedData {
  byTarget: Record<string, UnresolvedRef[]>;
}

export class UnresolvedRefStore {
  private static readonly KEY_PREFIX = 'dbclient.sync.unresolved';

  private readonly key: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly memento: MementoLike,
    userId: string,
    keyEpoch: string,
  ) {
    assertU64Decimal(userId, 'userId');
    assertU64Decimal(keyEpoch, 'keyEpoch');
    this.key = `${UnresolvedRefStore.KEY_PREFIX}.${userId}.${keyEpoch}`;
  }

  private read(): UnresolvedData {
    const raw = this.memento.get<unknown>(this.key);
    if (raw === undefined) return { byTarget: {} };
    if (typeof raw !== 'object' || raw === null) throw new Error('corrupt unresolved store');
    const o = raw as Record<string, unknown>;
    if (typeof o.byTarget !== 'object' || o.byTarget === null) throw new Error('corrupt unresolved store');
    return o as unknown as UnresolvedData;
  }

  private async write(data: UnresolvedData): Promise<void> {
    await this.memento.update(this.key, data);
  }

  listForTarget(recordId: string): UnresolvedRef[] {
    return this.read().byTarget[recordId] ?? [];
  }

  list(): UnresolvedRef[] {
    return Object.values(this.read().byTarget).flat();
  }

  async add(ref: UnresolvedRef): Promise<void> {
    await this.mutate(async () => {
      const data = this.read();
      const byTarget = { ...data.byTarget };
      const arr = [...(byTarget[ref.targetRecordId] ?? [])];
      if (!arr.some((r) => r.type === ref.type && r.localId === ref.localId && r.field === ref.field)) {
        arr.push(ref);
      }
      byTarget[ref.targetRecordId] = arr;
      await this.write({ byTarget });
    });
  }

  async remove(targetRecordId: string): Promise<void> {
    await this.mutate(async () => {
      const data = this.read();
      const byTarget = { ...data.byTarget };
      delete byTarget[targetRecordId];
      await this.write({ byTarget });
    });
  }

  async clear(): Promise<void> {
    await this.mutate(async () => {
      await this.write({ byTarget: {} });
    });
  }

  private mutate(change: () => Promise<void>): Promise<void> {
    const operation = this.writeChain.then(async () => {
      await change();
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }
}