import type { ConnectionStore, SavedConnection } from '../../connection/connectionStore';
import { decodeRecordPayload } from './recordCodec';
import { assertRecordId, assertU64Decimal } from './types';
import { filterPersonalConnectionsByEntitlement } from '../entitlementGate';
import type { CachedEntitlement } from '../authService';
import { RecordConflictError } from './errors';
import type { RecordMapStore } from './recordMapStore';

/**
 * 远端 record 的本地应用。
 *
 * - 版本幂等：仅对 `status='confirmed'` 且 version ≤ recordVersion 不重复写；`pending`
 *   预留视为未完成，重放继续收敛而非跳过。
 * - 新建顺序：先预留 pending 映射（recordId→connectionId）并写盘成功，再写连接，回读
 *   `updateTime` 后确认映射；预留失败不写连接。
 * - tombstone：confirmed 且本地未脏 → 删连接+删映射；本地脏 → 抛冲突（不删）；
 *   未映射 → 不建不报错（推进 cursor）。
 * - 本地脏 + 更高 version（仅 confirmed）→ 抛 RecordConflictError（不含秘密）。
 * - 写连接走 `source='sync'`；解密后先过引擎门禁（墓碑不走门禁）。
 * - 补偿失败时允许留下「有映射无连接」的 pending 状态（可自愈），绝不留「有连接无映射」。
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

  if (existing && existing.status === 'confirmed' && BigInt(version) <= BigInt(existing.recordVersion)) {
    return { recordId: input.recordId, disposition: 'skipped' };
  }

  if (input.tombstone) {
    if (existing) {
      const local = ctx.store.get(existing.connectionId);
      if (existing.status === 'confirmed' && local && (local.updateTime ?? 0) > existing.revision) {
        throw new RecordConflictError(input.recordId, existing.recordVersion, version);
      }
      await ctx.store.remove(existing.connectionId, 'sync');
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
    if (existing.status === 'confirmed' && local && (local.updateTime ?? 0) > existing.revision) {
      throw new RecordConflictError(input.recordId, existing.recordVersion, version);
    }
    const connectionId = local || existing.status === 'pending' ? existing.connectionId : ctx.uniqueConnectionId();
    await ctx.store.save({ ...conn, id: connectionId }, 'sync');
    const saved = ctx.store.get(connectionId);
    if (!saved || saved.updateTime === undefined) {
      if (local) await ctx.store.save(local, 'sync');
      else await ctx.store.remove(connectionId, 'sync');
      throw new Error('connection save did not report updateTime');
    }
    try {
      await ctx.mapStore.put(input.recordId, { connectionId, recordVersion: version, revision: saved.updateTime, status: 'confirmed' });
    } catch (error) {
      if (local) await ctx.store.save(local, 'sync');
      else await ctx.store.remove(connectionId, 'sync');
      throw error;
    }
    return { recordId: input.recordId, disposition: local ? 'updated' : 'created' };
  }

  // 新建：先预留 pending 映射，再写连接，最后确认版本。
  const connectionId = ctx.uniqueConnectionId();
  await ctx.mapStore.put(input.recordId, { connectionId, recordVersion: version, revision: 0, status: 'pending' });
  try {
    await ctx.store.save({ ...conn, id: connectionId }, 'sync');
  } catch {
    // save 失败回滚映射；回滚失败留下「有映射无连接」的 pending 状态，由 existing 分支自愈。
    let rollbackFailed = false;
    try {
      await ctx.mapStore.deleteByRecordId(input.recordId);
    } catch {
      rollbackFailed = true;
    }
    throw new Error(rollbackFailed
      ? 'apply failed and reservation rollback failed; pending mapping kept for recovery'
      : 'connection save failed and reservation rollback succeeded');
  }
  const saved = ctx.store.get(connectionId);
  if (!saved || saved.updateTime === undefined) {
    await ctx.mapStore.deleteByRecordId(input.recordId).catch(() => {});
    throw new Error('connection save did not report updateTime');
  }
  await ctx.mapStore.put(input.recordId, { connectionId, recordVersion: version, revision: saved.updateTime, status: 'confirmed' });
  return { recordId: input.recordId, disposition: 'created' };
}
