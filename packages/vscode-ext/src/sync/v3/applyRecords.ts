import type { ConnectionStore, SavedConnection } from '../../connection/connectionStore';
import { decodeRecordPayload } from './recordCodec';
import { assertRecordId, assertU64Decimal } from './types';
import { filterPersonalConnectionsByEntitlement } from '../entitlementGate';
import type { CachedEntitlement } from '../authService';
import { V3RecordConflictError } from './errors';
import type { RecordMapStore } from './recordMapStore';

/**
 * 远端 record 的本地应用（B3b，ADR-0007 #3 + 冻结裁定）。
 *
 * - 版本幂等：version ≤ 已确认 recordVersion 不重复写。
 * - tombstone：已映射且本地未脏 → 删连接 + 删映射；已映射但本地脏 → 抛冲突（不删）；
 *   未映射 → 不建不报错（推进 cursor）。
 * - 本地脏 + 更高 version（active 或 tombstone）→ 抛 V3RecordConflictError（不含秘密）。
 * - 写连接走 `source='v3-sync'`；解密后先过引擎门禁（墓碑不走门禁）。
 * - 全链路 async：await store 与 map 的持久化，避免「map 先于连接写入」。
 */

export type ApplyDisposition = 'skipped' | 'created' | 'updated' | 'deleted' | 'ignored-tombstone';

export interface ApplyRecordInput {
  recordId: string;
  version: string;
  tombstone: boolean;
  payload?: unknown;
}

export interface ApplyContext {
  store: ConnectionStore;
  mapStore: RecordMapStore;
  entitlement?: CachedEntitlement;
  uniqueConnectionId: () => string;
}

export interface ApplyRecordResult {
  recordId: string;
  disposition: ApplyDisposition;
}

export async function applyRecord(input: ApplyRecordInput, ctx: ApplyContext): Promise<ApplyRecordResult> {
  assertRecordId(input.recordId);
  const version = assertU64Decimal(input.version, 'version');
  const existing = ctx.mapStore.getByRecordId(input.recordId);

  if (existing && BigInt(version) <= BigInt(existing.recordVersion)) {
    return { recordId: input.recordId, disposition: 'skipped' };
  }

  if (input.tombstone) {
    if (existing) {
      const local = ctx.store.get(existing.connectionId);
      if (local && (local.updateTime ?? 0) > existing.revision) {
        throw new V3RecordConflictError(input.recordId, existing.recordVersion, version);
      }
      await ctx.store.remove(existing.connectionId, 'v3-sync');
      await ctx.mapStore.deleteByRecordId(input.recordId);
      return { recordId: input.recordId, disposition: 'deleted' };
    }
    return { recordId: input.recordId, disposition: 'ignored-tombstone' };
  }

  const decoded = decodeRecordPayload(input.payload);
  const conn: SavedConnection = { id: '', ...decoded, useConnectionString: false };
  const { skipped } = filterPersonalConnectionsByEntitlement([conn], ctx.entitlement);
  if (skipped.length > 0) {
    return { recordId: input.recordId, disposition: 'skipped' };
  }

  if (existing) {
    const local = ctx.store.get(existing.connectionId);
    if (local && (local.updateTime ?? 0) > existing.revision) {
      throw new V3RecordConflictError(input.recordId, existing.recordVersion, version);
    }
    const connectionId = local ? existing.connectionId : ctx.uniqueConnectionId();
    await ctx.store.save({ ...conn, id: connectionId }, 'v3-sync');
    const saved = ctx.store.get(connectionId);
    await ctx.mapStore.put(input.recordId, { connectionId, recordVersion: version, revision: saved?.updateTime ?? 0 });
    return { recordId: input.recordId, disposition: local ? 'updated' : 'created' };
  }

  const connectionId = ctx.uniqueConnectionId();
  await ctx.store.save({ ...conn, id: connectionId }, 'v3-sync');
  const saved = ctx.store.get(connectionId);
  await ctx.mapStore.put(input.recordId, { connectionId, recordVersion: version, revision: saved?.updateTime ?? 0 });
  return { recordId: input.recordId, disposition: 'created' };
}