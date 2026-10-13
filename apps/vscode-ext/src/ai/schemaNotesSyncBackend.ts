import type { EntityBackend, EntitySyncRecord, EntityValue } from '@devbelt/db-host/sync/e2e/entityStore';
import type { SyncEntityRef } from '@devbelt/db-host/sync/e2e/syncEntity';
import type { SyncSchemaNotesValue } from '@devbelt/db-host/sync/e2e/schemaNotesTypes';
import { AiContextStore } from './aiContextStore.js';

/**
 * schemaNotes 实体的宿主后端（S7f；镜像 AuthenticatorSyncBackend 模式）：
 * 以 AiContextStore 的**记录式**存储（含墓碑与 updateTime）为本地真身，
 * 供 db-host EntityStore/codec/apply/mutator 全链路按 `SyncEntityRef` 读写。
 *
 * - `localId` = 记录 id（'sn' 前缀）；`connId` 在本地值中是 localId（apply 时已换算）。
 * - 写入（含 sync 来源）由存储层打 updateTime；墓碑由 removeSchemaNoteRecord 承担。
 */
export class SchemaNotesSyncBackend implements EntityBackend {
  constructor(private readonly store: AiContextStore) {}

  listForSync(): EntitySyncRecord[] {
    return this.store.listSchemaNoteRecords().map((record) => ({
      ref: { type: 'schemaNotes', localId: record.id },
      deleted: record.deleted === true,
      updateTime: record.updateTime,
    }));
  }

  get(ref: SyncEntityRef): EntityValue | undefined {
    const record = this.store.getSchemaNoteRecord(ref.localId);
    if (!record) return undefined;
    const value: SyncSchemaNotesValue = {
      id: record.id,
      connId: record.connId,
      scope: record.scope,
      tables: record.tables as Record<string, unknown>,
      updateTime: record.updateTime,
      ...(record.deleted ? { deleted: true } : {}),
    };
    return value;
  }

  async save(ref: SyncEntityRef, entity: EntityValue): Promise<void> {
    const value = entity as SyncSchemaNotesValue;
    await this.store.saveSchemaNoteRecord(ref.localId, {
      connId: value.connId,
      scope: value.scope,
      tables: value.tables,
    });
  }

  async remove(ref: SyncEntityRef): Promise<void> {
    await this.store.removeSchemaNoteRecord(ref.localId);
  }
}