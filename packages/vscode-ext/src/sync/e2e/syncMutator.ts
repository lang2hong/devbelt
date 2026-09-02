import { randomBytes } from 'crypto';
import { encodeRecordPayload, sealRecord } from './recordCodec';
import { requestDigestOf } from '../crypto/digest';
import { buildRecordSigningInput, signSigningInput } from '../crypto/sign';
import { encodeBase64Url } from '../crypto/recoveryCode';
import { isOrganizationConnectionId } from '../entitlementGate';
import type { ConnectionStore, SavedConnection } from '../../connection/connectionStore';
import type { RecordMapStore } from './recordMapStore';
import { PendingMutationStore, type PendingDeleteMutation, type PendingPutMutation } from './pendingMutationStore';

/**
 * 本地连接变更 → 出站 mutation 生成（任务 3）。
 *
 * 全量对账（不依赖事件载荷拼接）：遍历 `listForSync()`（可见连接 + 软删除墓碑），对每个
 * connectionId 归纳差集，逐个生成已签名 record.put/record.delete 并**只追加**进 outbox。
 *
 * - 组织连接（`org:`）显式跳过，不依赖写入时抛错。
 * - `pending` 映射（入站应用未完成）与已有 outbox（每 record 至多一个 pending）跳过并汇总上报。
 * - baseVersion：新建 `"0"`；update/delete 取 confirmed 映射 `recordVersion`。
 * - outbox 条目持久化 payload 对应 revision（生成密文那刻 `updateTime`），receipt 确认用。
 * - record AAD.recordVersion 与服务端赋版本对齐：create → `"1"`；update → incU64(baseVersion)。
 */

export interface OutboundReconcileResult {
  generated: number;
  pendingSkipped: { recordId: string }[];
  skipped: { connectionId: string; reason: string }[];
}

export interface SyncMutatorDeps {
  userId: string;
  keyEpoch: string;
  store: ConnectionStore;
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
    const { store, mapStore, outbox } = this.deps;
    const outboxByConnection = new Map<string, boolean>();
    for (const m of outbox.list()) outboxByConnection.set(m.connectionId, true);

    const pendingSkipped: { recordId: string }[] = [];
    const skipped: { connectionId: string; reason: string }[] = [];
    let generated = 0;

    for (const conn of store.listForSync()) {
      if (isOrganizationConnectionId(conn.id)) continue;

      if (outboxByConnection.get(conn.id)) continue; // 每 record 至多一个 in-flight mutation

      const mapEntry = mapStore.getByConnectionId(conn.id);

      if (conn.deleted) {
        if (mapEntry && mapEntry.status === 'confirmed') {
          try {
            await outbox.put(this.buildDelete(mapEntry.recordId, conn.id, mapEntry.recordVersion, conn.updateTime ?? 0));
            generated += 1;
          } catch (err) {
            skipped.push({ connectionId: conn.id, reason: describe(err) });
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
          await outbox.put(this.buildPutOnNew(conn));
          generated += 1;
        } else if ((conn.updateTime ?? 0) > mapEntry.revision) {
          await outbox.put(this.buildPutOnExisting(mapEntry.recordId, conn, mapEntry.recordVersion));
          generated += 1;
        }
      } catch (err) {
        skipped.push({ connectionId: conn.id, reason: describe(err) });
      }
    }

    return { generated, pendingSkipped, skipped };
  }

  private buildPutOnNew(conn: SavedConnection): PendingPutMutation {
    return this.buildPut(mintId(16), conn, '0');
  }

  private buildPutOnExisting(recordId: string, conn: SavedConnection, baseVersion: string): PendingPutMutation {
    return this.buildPut(recordId, conn, baseVersion);
  }

  private buildPut(recordId: string, conn: SavedConnection, baseVersion: string): PendingPutMutation {
    const { userId, keyEpoch, dek, signSeed } = this.deps;
    const mutationId = mintId(16);
    const nonce = new Uint8Array(randomBytes(12));
    const revision = conn.updateTime ?? 0;
    const plaintext = Buffer.from(JSON.stringify(encodeRecordPayload(conn)), 'utf8');
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
      connectionId: conn.id,
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

  private buildDelete(recordId: string, connectionId: string, baseVersion: string, revision: number): PendingDeleteMutation {
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
      connectionId,
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