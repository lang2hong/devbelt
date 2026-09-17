import { randomBytes } from 'crypto';
import { encodeEntityPayload, sealRecord, type RefResolver } from './recordCodec';
import { requestDigestOf } from '../crypto/digest';
import { buildRecordSigningInput, signSigningInput } from '../crypto/sign';
import { encodeBase64Url } from '../crypto/recoveryCode';
import { isOrganizationConnectionId } from '../entitlementGate';
import type { RecordMapStore } from './recordMapStore';
import { PendingMutationStore, type PendingDeleteMutation, type PendingPutMutation } from './pendingMutationStore';
import { EntityStore, applyOrder, type EntityValue } from './entityStore';
import { refKey, isOrgLocalId, type SyncEntityRef } from './syncEntity';
import type { SavedConnection } from '../../connection/connectionStore';
import type { SavedQuery } from '@devkit/core';

/**
 * 本地实体变更 → 出站 mutation 生成（A4：全类型）。
 *
 * 按 applyOrder（group → queryFolder → connection → query）遍历 `EntityStore.listForSync()`
 * 的四类实体（含软删除墓碑），对每个 typed ref 归纳差集，逐个生成已签名 record.put/
 * record.delete 并**只追加**进 outbox。
 *
 * - org 排除：connection 的 localId 为 `org:` 前缀 → 跳过；query 的 connId 经 recordMap /
 *   本地反查为 `org:` 前缀连接 → 整条跳过（§三 / N7）。
 * - `pending` 映射（入站应用未完成）与已有 outbox（每实体至多一个）跳过并汇总上报。
 * - baseVersion：新建 `"0"`；update/delete 取 confirmed 映射 `recordVersion`。
 * - 引用转 recordId：同一轮内先 mint 的父实体 recordId 会被临时记入本轮 resolver，供
 *   connection.groupId / queryFolder.connId / query.connId·folderId 编码；跨轮已 confirmed
 *   的映射从 mapStore 反查。引用目标无 recordId 时省略该字段（unresolved，后续轮收敛）。
 * - record AAD.recordVersion 与服务端赋版本对齐：create → "1"；update → incU64(baseVersion)。
 */

export interface OutboundReconcileResult {
  generated: number;
  pendingSkipped: { recordId: string }[];
  skipped: { ref: string; reason: string }[];
}

export interface SyncMutatorDeps {
  userId: string;
  keyEpoch: string;
  entities: EntityStore;
  mapStore: RecordMapStore;
  outbox: PendingMutationStore;
  dek: () => Uint8Array;
  signSeed: () => Uint8Array;
}

function mintId(byteLen: number): string {
  return encodeBase64Url(new Uint8Array(randomBytes(byteLen)));
}

/** 生成密文那刻 seal 使用的 recordVersion：create 服务端恒赋 '1'；update 赋 baseVersion+1。 */
function recordVersionFor(baseVersion: string): string {
  return baseVersion === '0' ? '1' : (BigInt(baseVersion) + 1n).toString();
}

export class SyncMutator {
  constructor(private readonly deps: SyncMutatorDeps) {}

  async reconcile(): Promise<OutboundReconcileResult> {
    const { entities, mapStore, outbox } = this.deps;

    const outboxByRef = new Map<string, boolean>();
    for (const m of outbox.list()) outboxByRef.set(refKey({ type: m.type, localId: m.localId }), true);

    // 本轮内刚 mint 的 recordId（local → recordId），供依赖它的子实体编码引用。
    const minted = new Map<string, string>();

    const resolveRef: RefResolver = (type, localId) => {
      if (localId === undefined || localId === '') return undefined;
      const confirmed = mapStore.getByRef({ type, localId });
      if (confirmed) return confirmed.recordId;
      return minted.get(refKey({ type, localId }));
    };

    const pendingSkipped: { recordId: string }[] = [];
    const skipped: { ref: string; reason: string }[] = [];
    let generated = 0;

    const ordered = entities.listForSync().sort((a, b) => applyOrder(a.ref.type) - applyOrder(b.ref.type));

    for (const { ref, deleted, updateTime } of ordered) {
      if (isOrgLocalId(ref.type, ref.localId)) continue;
      if (ref.type === 'query' && this.isQueryOfOrgConnection(ref, entities)) continue;

      const key = refKey(ref);
      if (outboxByRef.get(key)) continue; // 每实体至多一个 in-flight mutation

      const mapEntry = mapStore.getByRef(ref);

      if (deleted) {
        if (mapEntry && mapEntry.status === 'confirmed') {
          try {
            await outbox.put(this.buildDelete(mapEntry.recordId, ref, mapEntry.recordVersion, updateTime));
            generated += 1;
          } catch (err) {
            skipped.push({ ref: key, reason: describe(err) });
          }
        } else if (mapEntry) {
          pendingSkipped.push({ recordId: mapEntry.recordId });
        }
        continue;
      }

      if (mapEntry && mapEntry.status === 'pending') {
        pendingSkipped.push({ recordId: mapEntry.recordId });
        continue;
      }

      try {
        if (!mapEntry) {
          const recordId = mintId(16);
          minted.set(key, recordId);
          await outbox.put(this.buildPutOnNew(recordId, ref, updateTime, resolveRef));
          generated += 1;
        } else if (updateTime > mapEntry.revision) {
          await outbox.put(this.buildPutOnExisting(mapEntry.recordId, ref, updateTime, mapEntry.recordVersion, resolveRef));
          generated += 1;
        }
      } catch (err) {
        skipped.push({ ref: key, reason: describe(err) });
      }
    }

    return { generated, pendingSkipped, skipped };
  }

  /**
   * B4 useLocal：读本地当前实体，以远端 `newBaseVersion` 为 baseVersion 重新 seal+sign
   * 单条 put mutation（recordVersion = inc(newBaseVersion)）。不写 outbox（由调用方 replaceMutation）。
   */
  rebasePut(recordId: string, ref: SyncEntityRef, newBaseVersion: string): PendingPutMutation {
    const entity = this.deps.entities.get(ref);
    if (!entity) throw new Error(`entity ${refKey(ref)} missing during rebase`);
    const revision = (entity as { updateTime?: number }).updateTime ?? 0;
    const resolveRef: RefResolver = (type, localId) => {
      if (localId === undefined || localId === '') return undefined;
      return this.deps.mapStore.getByRef({ type, localId })?.recordId;
    };
    return this.buildPut(recordId, ref, newBaseVersion, revision, resolveRef);
  }

  /** B4 useLocal（本地删除冲突）：以远端 currentVersion 为 baseVersion 重新签名 record.delete（保留删除意图）。 */
  rebaseDelete(recordId: string, ref: SyncEntityRef, newBaseVersion: string): PendingDeleteMutation {
    const entity = this.deps.entities.get(ref);
    const revision = (entity as { updateTime?: number }).updateTime ?? 0;
    return this.buildDelete(recordId, ref, newBaseVersion, revision);
  }

  private isQueryOfOrgConnection(ref: SyncEntityRef, entities: EntityStore): boolean {
    const q = entities.get(ref) as SavedQuery | undefined;
    if (!q) return false;
    return isOrganizationConnectionId(q.connId);
  }

  private buildPutOnNew(recordId: string, ref: SyncEntityRef, revision: number, resolveRef: RefResolver): PendingPutMutation {
    return this.buildPut(recordId, ref, '0', revision, resolveRef);
  }

  private buildPutOnExisting(recordId: string, ref: SyncEntityRef, revision: number, baseVersion: string, resolveRef: RefResolver): PendingPutMutation {
    return this.buildPut(recordId, ref, baseVersion, revision, resolveRef);
  }

  private buildPut(recordId: string, ref: SyncEntityRef, baseVersion: string, revision: number, resolveRef: RefResolver): PendingPutMutation {
    const { userId, keyEpoch, entities, dek, signSeed } = this.deps;
    const mutationId = mintId(16);
    const nonce = new Uint8Array(randomBytes(12));
    const entity = entities.get(ref);
    if (!entity) throw new Error(`entity ${refKey(ref)} missing during put`);
    const payload = this.encodePayload(ref, entity, resolveRef);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const box = sealRecord(dek(), nonce, plaintext, {
      userId,
      keyEpoch,
      recordId,
      recordVersion: recordVersionFor(baseVersion),
    });
    const nonceStr = encodeBase64Url(nonce);
    const ciphertext = encodeBase64Url(box.ciphertext);
    const tag = encodeBase64Url(box.tag);
    const body = {
      protocolVersion: 1,
      keyEpoch,
      mutationId,
      recordId,
      baseVersion,
      cipherSuite: 'AES-256-GCM',
      formatVersion: 1,
      nonce: nonceStr,
      ciphertext,
      tag,
    };
    const requestDigest = requestDigestOf(body);
    const signature = signSigningInput(
      buildRecordSigningInput('record.put', { userId, keyEpoch, mutationId, requestDigest, recordId, baseVersion }),
      signSeed(),
    );
    return {
      action: 'record.put',
      recordId,
      type: ref.type,
      localId: ref.localId,
      baseVersion,
      mutationId,
      signature,
      requestDigest,
      nonce: nonceStr,
      ciphertext,
      tag,
      revision,
      consecutiveFailureCount: 0,
    };
  }

  private encodePayload(ref: SyncEntityRef, entity: EntityValue, resolveRef: RefResolver): Record<string, unknown> {
    switch (ref.type) {
      case 'connection': return encodeEntityPayload({ type: 'connection', entity: entity as SavedConnection }, resolveRef);
      case 'group': return encodeEntityPayload({ type: 'group', entity: entity as never }, resolveRef);
      case 'queryFolder': return encodeEntityPayload({ type: 'queryFolder', entity: entity as never }, resolveRef);
      case 'query': return encodeEntityPayload({ type: 'query', entity: entity as never }, resolveRef);
    }
  }

  private buildDelete(recordId: string, ref: SyncEntityRef, baseVersion: string, revision: number): PendingDeleteMutation {
    const { userId, keyEpoch, signSeed } = this.deps;
    const mutationId = mintId(16);
    const body = { protocolVersion: 1, keyEpoch, mutationId, recordId, baseVersion };
    const requestDigest = requestDigestOf(body);
    const signature = signSigningInput(
      buildRecordSigningInput('record.delete', { userId, keyEpoch, mutationId, requestDigest, recordId, baseVersion }),
      signSeed(),
    );
    return {
      action: 'record.delete',
      recordId,
      type: ref.type,
      localId: ref.localId,
      baseVersion,
      mutationId,
      signature,
      requestDigest,
      revision,
      consecutiveFailureCount: 0,
    };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}