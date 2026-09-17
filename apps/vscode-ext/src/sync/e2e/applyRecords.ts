import type { SavedConnection, ConnectionGroup } from '../../connection/connectionStore';
import type { QueryFolder } from '../../connection/queryStore';
import type { SavedQuery } from '@devkit/db-core';
import { DatabaseType } from '@devkit/db-core';
import { decodeEntityPayload, type DecodedEntityPayload } from './recordCodec';
import { assertRecordId, assertU64Decimal } from './types';
import { filterPersonalConnectionsByEntitlement, isOrganizationConnectionId } from '../entitlementGate';
import type { CachedEntitlement } from '../authService';
import { RecordConflictError } from './errors';
import type { RecordMapStore, RecordMapEntry } from './recordMapStore';
import { EntityStore, UnresolvedRefStore } from './entityStore';
import type { SyncEntityType, SyncEntityRef } from './syncEntity';

/**
 * 远端 record 的本地应用（A3：四类型 + 拓扑序 + 引用解析 + 环检测 + 级联）。
 *
 * - 版本幂等：仅对 `status='confirmed'` 且 version ≤ recordVersion 不重复写；`pending`
 *   预留视为未完成，重放继续收敛而非跳过。
 * - 新建顺序：先预留 pending 映射（recordId→{type,localId}）并写盘成功，再写实体，回读
 *   `updateTime` 后确认映射；预留失败不写实体。
 * - tombstone：confirmed 且本地未脏 → 删实体（走 store 级联）+ 删映射；本地脏 → 抛冲突；
 *   未映射 → 不建不报错（推进 cursor）。tombstone 无 payload，靠映射反查实体类型。
 * - 引用解析（N2/N4）：parentId/groupId/connId/folderId 的 recordId 经 mapStore 反查本地
 *   id；未到达/类型不符 → 保留 unresolved（不落根），后续轮 reconcile 收敛。
 * - 环检测（N9）：group 应用前校验 parentId 不指向自身、不构成环、嵌套深度 ≤8。
 * - 级联由 store 承担（§三）：连接 tombstone 级联其查询/文件夹；分组 tombstone 仅解除成员
 *   连接分组；文件夹 tombstone 查询移根级。
 * - 写实体走 `source='sync'`；连接解密后先过引擎门禁（墓碑不走门禁）。
 * - 指向 org: 连接的查询整条跳过（§三/N7）。
 */

export type ApplyDisposition = 'skipped' | 'created' | 'updated' | 'deleted' | 'ignored-tombstone';

export interface ApplyRecordInput {
  recordId: string;
  version: string;
  tombstone: boolean;
  payload?: unknown;
  /** B4 useRemote：跳过本地脏冲突检查，强制采用远端版本。 */
  force?: boolean;
}

export interface ApplyContext {
  entities: EntityStore;
  mapStore: RecordMapStore;
  unresolved: UnresolvedRefStore;
  entitlement?: CachedEntitlement;
  /** 为新本地实体 mint id（按类型）。 */
  uniqueId: (type: SyncEntityType) => string;
}

export interface ApplyRecordResult {
  recordId: string;
  disposition: ApplyDisposition;
}

/**
 * 收敛 unresolved 引用（N2/N4）：对每条 unresolved 引用，若 target recordId 现已映射到
 * 本地实体，则把依赖方实体的引用字段改写为本地 id 并清除该 unresolved 条目；未映射的
 * 保留待后续轮。返回本次收敛条数。
 */
export async function reconcileUnresolved(ctx: ApplyContext): Promise<number> {
  let resolved = 0;
  for (const uref of ctx.unresolved.list()) {
    const entity = ctx.entities.get({ type: uref.type, localId: uref.localId });
    if (!entity) {
      // 依赖方实体已不存在（被删/tombstone 移除），清理悬空引用。
      await ctx.unresolved.remove(uref.targetRecordId);
      continue;
    }
    const target = ctx.mapStore.getByRecordId(uref.targetRecordId);
    if (!target) continue; // 目标未到达，保留待后续轮
    await patchReference(ctx, uref, target.localId);
    await ctx.unresolved.remove(uref.targetRecordId);
    resolved += 1;
  }
  return resolved;
}

async function patchReference(ctx: ApplyContext, uref: { type: SyncEntityType; localId: string; field: 'groupId' | 'parentId' | 'connId' | 'folderId' }, targetLocalId: string): Promise<void> {
  const ref: SyncEntityRef = { type: uref.type, localId: uref.localId };
  const entity = ctx.entities.get(ref);
  const patched = { ...(entity as unknown as Record<string, unknown>), [uref.field]: targetLocalId };
  await ctx.entities.save(ref, patched as never, 'sync');
}

function resolveLocalId(mapStore: RecordMapStore, type: SyncEntityType, recordId: string | undefined): string | undefined {
  if (!recordId) return undefined;
  const entry = mapStore.getByRecordId(recordId);
  if (!entry || entry.type !== type) return undefined;
  return entry.localId;
}

/** 环/自指/超深检测（N9）：group 应用前父链校验，最多 8 层。 */
export function assertSafeGroupParent(groups: ConnectionGroup[], selfId: string, parentId: string): void {
  if (parentId === selfId) throw new Error('group hierarchy must not contain a cycle');
  let cur = parentId;
  let depth = 0;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) throw new Error('group hierarchy must not contain a cycle');
    seen.add(cur);
    const parent = groups.find((g) => g.id === cur);
    if (!parent || !parent.parentId) break;
    cur = parent.parentId;
    depth += 1;
    if (depth > 8) throw new Error('group hierarchy exceeds maximum depth of 8');
  }
}

function updateTimeOf(entity: unknown): number {
  return (entity as { updateTime?: number })?.updateTime ?? 0;
}

export async function applyRecord(input: ApplyRecordInput, ctx: ApplyContext): Promise<ApplyRecordResult> {
  assertRecordId(input.recordId);
  const version = assertU64Decimal(input.version, 'version');
  const existing = ctx.mapStore.getByRecordId(input.recordId);

  if (!input.force && existing && existing.status === 'confirmed' && BigInt(version) <= BigInt(existing.recordVersion)) {
    return { recordId: input.recordId, disposition: 'skipped' };
  }

  if (input.tombstone) {
    return applyTombstone(input.recordId, version, existing, ctx, input.force === true);
  }

  const decoded = decodeEntityPayload(input.payload);
  return applyActive(input.recordId, version, decoded, existing, ctx, input.force === true);
}

async function applyTombstone(recordId: string, version: string, existing: (RecordMapEntry & { recordId: string }) | undefined, ctx: ApplyContext, force: boolean): Promise<ApplyRecordResult> {
  if (!existing) {
    return { recordId, disposition: 'ignored-tombstone' };
  }
  const ref: SyncEntityRef = { type: existing.type, localId: existing.localId };
  const local = ctx.entities.get(ref);
  if (existing.status === 'pending' && local) {
    if (!force) throw new RecordConflictError(recordId, existing.recordVersion, version, 'pending');
  }
  if (existing.status === 'confirmed' && local && updateTimeOf(local) > existing.revision) {
    if (!force) throw new RecordConflictError(recordId, existing.recordVersion, version);
  }
  await ctx.entities.remove(ref, 'sync');
  await ctx.mapStore.deleteByRecordId(recordId);
  return { recordId, disposition: 'deleted' };
}

async function applyActive(
  recordId: string,
  version: string,
  decoded: DecodedEntityPayload,
  existing: (RecordMapEntry & { recordId: string }) | undefined,
  ctx: ApplyContext,
  force: boolean,
): Promise<ApplyRecordResult> {
  const type = decoded.type;

  // 指向 org: 连接的查询整条跳过（N7）。
  if (type === 'query') {
    const connId = resolveLocalId(ctx.mapStore, 'connection', decoded.data.connId);
    if (connId !== undefined && isOrganizationConnectionId(connId)) {
      return { recordId, disposition: 'ignored-tombstone' };
    }
  }

  if (type === 'connection') {
    const { skipped } = filterPersonalConnectionsByEntitlement(
      [buildConnectionFromPayload(decoded.data)],
      ctx.entitlement,
    );
    if (skipped.length > 0) {
      return { recordId, disposition: 'skipped' };
    }
  }

  if (existing) {
    const local = ctx.entities.get({ type, localId: existing.localId });
    if (existing.status === 'pending' && local && !force) {
      throw new RecordConflictError(recordId, existing.recordVersion, version, 'pending');
    }
    if (existing.status === 'confirmed' && local && updateTimeOf(local) > existing.revision && !force) {
      throw new RecordConflictError(recordId, existing.recordVersion, version);
    }
    const targetRef: SyncEntityRef = { type, localId: local ? existing.localId : ctx.uniqueId(type) };
    await writeEntity(targetRef, decoded, ctx);
    const saved = ctx.entities.get(targetRef);
    if (!saved || updateTimeOf(saved) === undefined) {
      throw new Error('entity save did not report updateTime');
    }
    try {
      await ctx.mapStore.put(recordId, { type, localId: targetRef.localId, recordVersion: version, revision: updateTimeOf(saved), status: 'confirmed' });
    } catch (error) {
      if (local) await restoreEntity({ type, localId: existing.localId }, local, ctx);
      else await ctx.entities.remove(targetRef, 'sync');
      throw error;
    }
    return { recordId, disposition: local ? 'updated' : 'created' };
  }

  // 新建：先预留 pending 映射，再写实体，最后确认版本。
  const newId = ctx.uniqueId(type);
  await ctx.mapStore.put(recordId, { type, localId: newId, recordVersion: version, revision: 0, status: 'pending' });
  try {
    await writeEntity({ type, localId: newId }, decoded, ctx);
  } catch (error) {
    let rollbackFailed = false;
    try {
      await ctx.mapStore.deleteByRecordId(recordId);
    } catch {
      rollbackFailed = true;
    }
    const causeError = new Error(rollbackFailed
      ? 'apply failed and reservation rollback failed; pending mapping kept for recovery'
      : 'entity save failed and reservation rollback succeeded') as Error & { cause?: unknown };
    causeError.cause = error;
    throw causeError;
  }
  const saved = ctx.entities.get({ type, localId: newId });
  if (!saved || updateTimeOf(saved) === undefined) {
    await ctx.mapStore.deleteByRecordId(recordId).catch(() => {});
    throw new Error('entity save did not report updateTime');
  }
  await ctx.mapStore.put(recordId, { type, localId: newId, recordVersion: version, revision: updateTimeOf(saved), status: 'confirmed' });
  return { recordId, disposition: 'created' };
}

async function restoreEntity(ref: SyncEntityRef, original: unknown, ctx: ApplyContext): Promise<void> {
  switch (ref.type) {
    case 'connection': return ctx.entities.save(ref, original as SavedConnection, 'sync');
    case 'group': return ctx.entities.save(ref, original as ConnectionGroup, 'sync');
    case 'queryFolder': return ctx.entities.save(ref, original as QueryFolder, 'sync');
    case 'query': return ctx.entities.save(ref, original as SavedQuery, 'sync');
  }
}

async function writeEntity(ref: SyncEntityRef, decoded: DecodedEntityPayload, ctx: ApplyContext): Promise<void> {
  // 分组环检测：应用前校验 parentId 解析结果（N9）。
  let parentLocalId: string | undefined;
  switch (decoded.type) {
    case 'connection': {
      const groupLocalId = resolveLocalId(ctx.mapStore, 'group', decoded.data.groupId);
      if (decoded.data.groupId && groupLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.groupId, type: ref.type, localId: ref.localId, field: 'groupId' });
      }
      await ctx.entities.save(ref, buildConnectionFromPayload(decoded.data, ref.localId, groupLocalId), 'sync');
      return;
    }
    case 'group': {
      parentLocalId = resolveLocalId(ctx.mapStore, 'group', decoded.data.parentId);
      if (decoded.data.parentId && parentLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.parentId, type: ref.type, localId: ref.localId, field: 'parentId' });
      } else if (parentLocalId) {
        assertSafeGroupParent(collectionOfGroups(ctx.entities), ref.localId, parentLocalId);
      }
      await ctx.entities.save(ref, buildGroupFromPayload(decoded.data, ref.localId, parentLocalId), 'sync');
      return;
    }
    case 'queryFolder': {
      const connLocalId = resolveLocalId(ctx.mapStore, 'connection', decoded.data.connId);
      if (decoded.data.connId && connLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.connId, type: ref.type, localId: ref.localId, field: 'connId' });
      }
      await ctx.entities.save(ref, buildFolderFromPayload(decoded.data, ref.localId, connLocalId), 'sync');
      return;
    }
    case 'query': {
      const connLocalId = resolveLocalId(ctx.mapStore, 'connection', decoded.data.connId);
      if (decoded.data.connId && connLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.connId, type: ref.type, localId: ref.localId, field: 'connId' });
      }
      const folderLocalId = resolveLocalId(ctx.mapStore, 'queryFolder', decoded.data.folderId);
      if (decoded.data.folderId && folderLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.folderId, type: ref.type, localId: ref.localId, field: 'folderId' });
      }
      await ctx.entities.save(ref, buildQueryFromPayload(decoded.data, ref.localId, connLocalId, folderLocalId), 'sync');
      return;
    }
  }
}

function collectionOfGroups(entities: EntityStore): ConnectionGroup[] {
  const out: ConnectionGroup[] = [];
  for (const rec of entities.listForSync()) {
    if (rec.ref.type === 'group') {
      const g = entities.get(rec.ref) as ConnectionGroup | undefined;
      if (g) out.push(g);
    }
  }
  return out;
}

function buildConnectionFromPayload(p: Extract<DecodedEntityPayload, { type: 'connection' }>['data'], id?: string, groupId?: string): SavedConnection {
  const { groupId: _groupId, ...rest } = p as unknown as Record<string, unknown>;
  const base = p.dbType === DatabaseType.SQLITE
    ? { id: id ?? '', host: '', port: 0, user: '', useConnectionString: false }
    : { id: id ?? '', useConnectionString: false };
  return { ...base, ...rest, groupId } as unknown as SavedConnection;
}

function buildGroupFromPayload(p: Extract<DecodedEntityPayload, { type: 'group' }>['data'], id: string, parentId: string | undefined): ConnectionGroup {
  return { id, name: p.name, parentId } as ConnectionGroup;
}

function buildFolderFromPayload(p: Extract<DecodedEntityPayload, { type: 'queryFolder' }>['data'], id: string, connId: string | undefined): QueryFolder {
  return { id, name: p.name, connId: connId ?? '' } as QueryFolder;
}

function buildQueryFromPayload(p: Extract<DecodedEntityPayload, { type: 'query' }>['data'], id: string, connId: string | undefined, folderId: string | undefined): SavedQuery {
  return {
    id,
    name: p.name,
    sql: p.sql,
    connId: connId ?? '',
    database: p.database,
    folderId,
  } as SavedQuery;
}