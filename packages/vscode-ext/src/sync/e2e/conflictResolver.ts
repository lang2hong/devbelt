import { openRecord } from './recordCodec';
import { applyRecord, type ApplyContext } from './applyRecords';
import type { RecordMapStore } from './recordMapStore';
import { PendingMutationStore } from './pendingMutationStore';
import type { EntityStore, UnresolvedRefStore } from './entityStore';
import type { SyncMutator } from './syncMutator';
import type { SyncEntityType, SyncEntityRef } from './syncEntity';
import type { CachedEntitlement } from '../authService';

/**
 * B4 冲突解析器：以「单 record 至多一条 in-flight」的 outbox 条目为冲突载体，
 * 提供 Use Local / Use Remote 两种原子迁移（Cancel 为 noop，由调用方保持现状）。
 *
 * - Use Local：读本地当前实体，以远端 currentVersion 为 baseVersion 重新 seal+sign，
 *   `replaceMutation` 换上无冲突的新 mutation（consecutiveFailureCount=0），下轮 push 覆盖远端。
 * - Use Remote：解密冲突条目保存的远端密文，`applyRecord(force=true)` 强制采用远端并删 outbox 条目。
 *
 * 冲突条目的密文由入站冲突（pull applyRecord 抛 RecordConflictError）补全；若尚未补全
 * （出站冲突当轮、未 pull），Use Remote 抛错，UI 提示先触发一轮 sync。
 */
export interface ConflictItem {
  recordId: string;
  type: SyncEntityType;
  localId: string;
  kind: 'version' | 'pending';
  remoteVersion: string;
}

export interface ConflictResolverDeps {
  userId: string;
  keyEpoch: string;
  mapStore: RecordMapStore;
  outbox: PendingMutationStore;
  entities: EntityStore;
  unresolved: UnresolvedRefStore;
  dek: () => Uint8Array;
  mutator: SyncMutator;
  entitlement?: () => CachedEntitlement | undefined;
  uniqueId: (type: SyncEntityType) => string;
}

export class ConflictResolver {
  constructor(private readonly deps: ConflictResolverDeps) {}

  /** 当前未解决冲突列表（来自 outbox 的 conflict 字段）。 */
  list(): ConflictItem[] {
    const items: ConflictItem[] = [];
    for (const m of this.deps.outbox.list()) {
      if (!m.conflict) continue;
      items.push({
        recordId: m.recordId,
        type: m.type,
        localId: m.localId,
        kind: m.conflict.kind,
        remoteVersion: m.conflict.remoteRecordVersion,
      });
    }
    return items;
  }

  /** Use Local：保留本地（put 或 delete），rebase 到远端 currentVersion 后重新入 outbox。 */
  async useLocal(recordId: string): Promise<void> {
    const mutation = this.deps.outbox.list().find((m) => m.recordId === recordId && m.conflict);
    if (!mutation) return;
    const ref: SyncEntityRef = { type: mutation.type, localId: mutation.localId };
    const baseVersion = mutation.conflict!.currentVersion;
    const next = mutation.action === 'record.delete'
      ? this.deps.mutator.rebaseDelete(recordId, ref, baseVersion)
      : this.deps.mutator.rebasePut(recordId, ref, baseVersion);
    await this.deps.outbox.replaceMutation(mutation.mutationId, next);
  }

  /** Use Remote：采用远端，按远端真实状态（active/tombstone/未拉取）强制应用并丢弃本地未同步修改。 */
  async useRemote(recordId: string): Promise<void> {
    const mutation = this.deps.outbox.list().find((m) => m.recordId === recordId && m.conflict);
    if (!mutation) return;
    const conflict = mutation.conflict!;

    if (conflict.remoteTombstone === true) {
      // 远端是 tombstone：强制应用 tombstone（无论本地 mutation 是 put 还是 delete）。
      await applyRecord({ recordId, version: conflict.remoteRecordVersion, tombstone: true, force: true }, this.ctx());
    } else if (conflict.remoteTombstone === false) {
      // 远端是 active record：要求并解密密文后强制还原。
      if (!conflict.remoteNonce || !conflict.remoteCiphertext || !conflict.remoteTag) {
        throw new Error('remote ciphertext not yet available; sync again before Use Remote');
      }
      const plaintext = openRecord(
        this.deps.dek(),
        Buffer.from(conflict.remoteNonce, 'base64url'),
        Buffer.from(conflict.remoteCiphertext, 'base64url'),
        Buffer.from(conflict.remoteTag, 'base64url'),
        { userId: this.deps.userId, keyEpoch: this.deps.keyEpoch, recordId, recordVersion: conflict.remoteRecordVersion },
      );
      await applyRecord(
        { recordId, version: conflict.remoteRecordVersion, tombstone: false, payload: JSON.parse(Buffer.from(plaintext).toString('utf8')), force: true },
        this.ctx(),
      );
    } else {
      // undefined：远端版本尚未拉取（出站 409 未 enrich）。
      throw new Error('remote version not yet fetched; sync again before Use Remote');
    }
    await this.deps.outbox.delete(mutation.mutationId);
  }

  private ctx(): ApplyContext {
    return {
      entities: this.deps.entities,
      mapStore: this.deps.mapStore,
      unresolved: this.deps.unresolved,
      entitlement: this.deps.entitlement?.(),
      uniqueId: this.deps.uniqueId,
    };
  }
}